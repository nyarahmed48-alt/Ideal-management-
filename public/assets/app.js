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

  /* ====================================================== CV file picker == */

  const MAX_CV_BYTES = 8 * 1024 * 1024;

  const dropzone = $("#dropzone");
  const cvFile = $("#cv-file");
  const dropzoneText = $("#dropzone-text");

  if (dropzone && cvFile && dropzoneText) {
    const describe = (file) => {
      const mb = file.size / (1024 * 1024);
      const size = mb < 0.1 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${mb.toFixed(1)} MB`;
      return `${file.name} · ${size}`;
    };

    const showFile = () => {
      const file = cvFile.files && cvFile.files[0];
      if (!file) {
        dropzone.classList.remove("has-file");
        dropzoneText.innerHTML = "<strong>Choose a file</strong> or drop it here";
        return;
      }
      if (file.size > MAX_CV_BYTES) {
        // Rejecting here beats a 20-second upload that ends in a 413.
        cvFile.value = "";
        dropzone.classList.remove("has-file");
        dropzoneText.innerHTML = "<strong>That file is over 8 MB.</strong> Please choose a smaller one.";
        return;
      }
      dropzone.classList.add("has-file");
      dropzoneText.textContent = describe(file);
    };

    cvFile.addEventListener("change", showFile);

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
        showFile();
      }
    });

    /* A picked file is a reference, not a copy, and the reference can go stale
       — moved, edited, or (commonly on mobile) chosen from a cloud provider
       that later withdraws it. The browser only discovers this mid-upload, and
       what the visitor sees is a blank error page reading
       ERR_UPLOAD_FILE_CHANGED, with their filled-in form gone.

       So read one byte before letting the submit go. If that fails the file is
       already unreadable, and saying so — with the form still on screen — beats
       finding out after the navigation. */
    const cvForm = $("#cv-form");
    const cvStatus = $("#cv-status");
    if (cvForm) {
      cvForm.addEventListener("submit", (event) => {
        const file = cvFile.files && cvFile.files[0];
        // Nothing chosen: let the browser's own required-field message handle it.
        if (!file) return;

        event.preventDefault();
        file
          .slice(0, 1)
          .arrayBuffer()
          .then(() => {
            // Readable. Submit natively, bypassing this listener.
            HTMLFormElement.prototype.submit.call(cvForm);
          })
          .catch(() => {
            dropzone.classList.remove("has-file");
            cvFile.value = "";
            dropzoneText.innerHTML = "<strong>Choose your CV again</strong> or drop it here";
            if (cvStatus) {
              cvStatus.className = "form__status is-error";
              cvStatus.textContent =
                "Your device can no longer read that file — it may have been moved, or picked from cloud storage that has since released it. Please choose it again. Saving it to this device first is the most reliable.";
            }
            dropzone.scrollIntoView({ block: "center", behavior: "smooth" });
          });
      });
    }
  }

  /* ========================================================= form submit ==

     The three forms submit natively — no fetch, no interception.

     They were AJAX at first, for an inline success panel without leaving the
     page. Netlify rejected those POSTs and the browser gave us nothing to go
     on, so this trades a nicety for the path the form host documents and tests
     hardest: a plain browser submit to action="/thanks". When it fails now it
     fails onto a page that says why, instead of a red line that cannot.

     What is left below is the file picker, which is presentation only. If the
     inline panel is worth another attempt later, bring it back as an
     enhancement over a form that already works without it.
  ========================================================================== */

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
