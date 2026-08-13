/**
 * Ideal Management — site behaviour.
 *
 * Three independent pieces, each guarded so a missing element on some future
 * page cannot take the others down with it:
 *   1. navigation (mobile menu, sticky header state)
 *   2. the CV Pool forms (file picker + AJAX submit to Netlify Forms)
 *   3. Ideal AI (the chat widget, talking to /api/ideal-chat)
 *
 * No build step and no dependencies: this file ships as written.
 */

(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ========================================================= navigation === */

  const nav = $("#nav");
  const navToggle = $("#nav-toggle");
  const navLinks = $("#nav-links");

  if (navToggle && navLinks) {
    const setOpen = (open) => {
      navToggle.setAttribute("aria-expanded", String(open));
      navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      navLinks.classList.toggle("is-open", open);
    };

    navToggle.addEventListener("click", () => {
      setOpen(navToggle.getAttribute("aria-expanded") !== "true");
    });

    // Tapping a link on mobile should navigate and close, not leave the menu
    // covering the section it just jumped to.
    navLinks.addEventListener("click", (event) => {
      if (event.target.closest("a")) setOpen(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
  }

  if (nav) {
    const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  const year = $("#year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* ====================================================== CV file picker ==

     Why this is more than a styled <input type="file">.

     A picked file is a reference, not a copy. On Android especially, a CV
     chosen from Google Drive is a content:// URI the provider can withdraw at
     any moment — and the browser only discovers that mid-upload, aborting with
     ERR_UPLOAD_FILE_CHANGED and dumping the visitor on a blank error page with
     everything they typed gone. Drive is where most people keep their CV, so
     this is the common case, not an edge one.

     So the file is read into memory the moment it is chosen, while the
     reference is certainly still good, and the submit sends that copy. What
     the provider does afterwards stops mattering. Reading a cloud file also
     forces it to download, which is why picking one shows a preparing state.
  ========================================================================== */

  const MAX_CV_BYTES = 8 * 1024 * 1024;

  const dropzone = $("#dropzone");
  const cvFile = $("#cv-file");
  const dropzoneText = $("#dropzone-text");
  const cvForm = $("#cv-form");
  const cvStatus = $("#cv-status");
  const cvSubmit = $("#cv-submit");

  if (dropzone && cvFile && dropzoneText) {
    /** The in-memory copy: what actually gets uploaded. */
    let held = null;
    /** True while a file is being read, so submit can wait rather than fail. */
    let reading = false;

    const setStatus = (text, kind) => {
      if (!cvStatus) return;
      cvStatus.className = "form__status" + (kind ? ` is-${kind}` : "");
      cvStatus.textContent = text || "";
    };

    const describe = (name, size) => {
      const mb = size / (1024 * 1024);
      const pretty = mb < 0.1 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${mb.toFixed(1)} MB`;
      return `${name} · ${pretty}`;
    };

    const clearFile = (message) => {
      held = null;
      cvFile.value = "";
      dropzone.classList.remove("has-file", "is-reading");
      dropzoneText.innerHTML = message || "<strong>Choose a file</strong> or drop it here";
    };

    const take = async (file) => {
      if (!file) return clearFile();

      if (file.size > MAX_CV_BYTES) {
        clearFile("<strong>That file is over 8 MB.</strong> Please choose a smaller one.");
        setStatus("");
        return;
      }

      held = null;
      reading = true;
      dropzone.classList.remove("has-file");
      dropzone.classList.add("is-reading");
      dropzoneText.innerHTML = "<strong>Preparing your file…</strong> this can take a moment from cloud storage";
      setStatus("");
      if (cvSubmit) cvSubmit.disabled = true;

      try {
        // Reading now is the whole point: the copy outlives the reference.
        const buffer = await file.arrayBuffer();
        held = {
          blob: new Blob([buffer], { type: file.type || "application/octet-stream" }),
          name: file.name || "cv",
          size: buffer.byteLength,
        };
        dropzone.classList.remove("is-reading");
        dropzone.classList.add("has-file");
        dropzoneText.textContent = describe(held.name, held.size);
      } catch (error) {
        console.error("Could not read the chosen file", error);
        clearFile("<strong>Choose your CV again</strong> or drop it here");
        setStatus(
          "Your device could not read that file. If it is in Google Drive or another cloud app, " +
            "download it to this device first, then choose it again.",
          "error",
        );
      } finally {
        reading = false;
        if (cvSubmit) cvSubmit.disabled = false;
      }
    };

    cvFile.addEventListener("change", () => take(cvFile.files && cvFile.files[0]));

    ["dragenter", "dragover"].forEach((type) =>
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add("is-dragging");
      }),
    );
    ["dragleave", "drop"].forEach((type) =>
      dropzone.addEventListener(type, () => dropzone.classList.remove("is-dragging")),
    );

    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      const dropped = event.dataTransfer && event.dataTransfer.files;
      if (dropped && dropped.length) {
        cvFile.files = dropped;
        take(dropped[0]);
      }
    });

    /* Submit the copy rather than the reference. Without JavaScript the form
       still posts natively — worse for cloud files, but never broken. */
    if (cvForm) {
      cvForm.addEventListener("submit", async (event) => {
        if (reading) {
          event.preventDefault();
          setStatus("Still preparing your file — one moment, then press again.", "");
          return;
        }
        // No copy held: let the browser's own required-field handling speak.
        if (!held) return;

        event.preventDefault();
        if (cvSubmit) {
          cvSubmit.disabled = true;
          cvSubmit.textContent = "Uploading…";
        }
        setStatus("");

        try {
          const body = new FormData(cvForm);
          // Replace the live reference with the copy taken at pick time.
          body.set("cv", held.blob, held.name);

          const response = await fetch(cvForm.getAttribute("action") || "/api/submit", {
            method: "POST",
            body,
          });
          if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });

          window.location.assign("/thanks");
        } catch (error) {
          console.error("CV submission failed", error);
          const code = error && error.status;
          setStatus(
            "That did not go through" +
              (code ? ` (error ${code})` : " — no response from the server") +
              ". Please try again, or send your CV to imanagement19@gmail.com, or WhatsApp +964 772 252 1000.",
            "error",
          );
          if (cvSubmit) {
            cvSubmit.disabled = false;
            cvSubmit.textContent = "Join the CV Pool";
          }
        }
      });
    }
  }

  /* ============================================================ Ideal AI == */

  const CHAT_ENDPOINT = "/api/ideal-chat";
  /** Turns sent back as context. Enough to hold a thread, small enough to stay cheap. */
  const HISTORY_LIMIT = 10;

  const fab = $("#chat-fab");
  const panel = $("#chat-panel");
  const log = $("#chat-log");
  const chatForm = $("#chat-form");
  const input = $("#chat-input");
  const sendBtn = $("#chat-send");
  const suggestions = $("#chat-suggestions");

  if (fab && panel && log && chatForm && input) {
    /** @type {{role: "user"|"assistant", content: string}[]} */
    const history = [];
    let greeted = false;
    let busy = false;

    const scrollDown = () => {
      log.scrollTop = log.scrollHeight;
    };

    const addBubble = (role, text) => {
      const el = document.createElement("p");
      el.className = `bubble bubble--${role === "user" ? "user" : "ai"}`;
      el.textContent = text;
      log.appendChild(el);
      scrollDown();
      return el;
    };

    const addTyping = () => {
      const el = document.createElement("p");
      el.className = "bubble bubble--ai";
      el.innerHTML = '<span class="chat__typing"><i></i><i></i><i></i></span>';
      log.appendChild(el);
      scrollDown();
      return el;
    };

    const openChat = (open) => {
      panel.hidden = !open;
      fab.setAttribute("aria-expanded", String(open));
      if (!open) return;
      if (!greeted) {
        greeted = true;
        addBubble(
          "assistant",
          "Hi — I'm Ideal AI, the assistant for Ideal Management. Ask me about our services, how the CV Pool works, or what happens after you apply. If something needs a person, I'll say so.",
        );
      }
      input.focus();
    };

    fab.addEventListener("click", () => openChat(panel.hidden));
    const closeBtn = $("#chat-close");
    if (closeBtn) closeBtn.addEventListener("click", () => openChat(false));
    $$("[data-open-chat]").forEach((el) => el.addEventListener("click", () => openChat(true)));

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        openChat(false);
        fab.focus();
      }
    });

    const send = async (text) => {
      const message = text.trim();
      if (!message || busy) return;

      busy = true;
      if (sendBtn) sendBtn.disabled = true;
      if (suggestions) suggestions.hidden = true;
      input.value = "";

      addBubble("user", message);
      const typing = addTyping();

      try {
        const response = await fetch(CHAT_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, history: history.slice(-HISTORY_LIMIT) }),
        });

        // The endpoint answers with JSON on every path it controls, including
        // its own failures — so a parse error here means something in front of
        // it (a proxy, a 502 page) answered instead.
        const payload = await response.json().catch(() => null);
        const reply = payload && typeof payload.reply === "string" ? payload.reply.trim() : "";

        typing.remove();

        if (!reply) {
          addBubble(
            "assistant",
            (payload && payload.message) ||
              "I couldn't reach my assistant service just now. Please try again in a moment, or contact us on +964 772 252 1000.",
          );
        } else {
          addBubble("assistant", reply);
          history.push({ role: "user", content: message }, { role: "assistant", content: reply });
        }
      } catch (error) {
        console.error("Ideal AI request failed", error);
        typing.remove();
        addBubble(
          "assistant",
          "I'm having trouble connecting. Check your network and try again — or contact us on +964 772 252 1000 and a person will answer.",
        );
      } finally {
        busy = false;
        if (sendBtn) sendBtn.disabled = false;
        input.focus();
      }
    };

    chatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      send(input.value);
    });

    if (suggestions) {
      suggestions.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (button) send(button.textContent || "");
      });
    }
  }
})();
