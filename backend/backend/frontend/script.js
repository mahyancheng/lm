/* frontend/script.js
   -------------------------------------------------------------
   ❶  Waits for DOMContentLoaded                 (fixes empty UI)
   ❷  Fetches /api/models and populates three <select>s
   ❸  Sends chosen models in every WebSocket message
----------------------------------------------------------------*/
document.addEventListener("DOMContentLoaded", () => {
    /* ─── grab DOM handles ──────────────────────────────────── */
    const $ = (id) => document.getElementById(id);
    const inp  = $("userInput");
    const send = $("sendButton");
    const chat = $("chatHistory");
    const tasks= $("taskList");
    const plannerSel = $("modelSelect");          // already in markup
    let browserSel, codeSel;                      // injected later
  
    /* ─── populate model dropdowns ───────────────────────────── */
    const makeSelect = (id, labelTxt, models) => {
      const wrap  = document.createElement("div");
      const label = document.createElement("label");
      label.textContent = labelTxt + ": ";
      const sel   = document.createElement("select");
      sel.id = id;
      models.forEach((m) => {
        const o = document.createElement("option");
        o.value = o.textContent = m;
        sel.appendChild(o);
      });
      label.appendChild(sel);
      wrap.appendChild(label);
      plannerSel.parentNode.appendChild(wrap);
      return sel;
    };
  
    fetch("/api/models")
      .then((r) => r.json())
      .then(({models}) => {
        if (!models?.length) throw new Error("no models");
        /* planner select already exists */
        models.forEach((m) => {
          const o = document.createElement("option");
          o.value = o.textContent = m;
          plannerSel.appendChild(o);
        });
        browserSel = makeSelect("browserModelSelect", "Browser LLM", models);
        codeSel    = makeSelect("codeModelSelect",    "Code LLM",    models);
      })
      .catch((e) => {
        console.error("model load failed", e);
        ["llama3:latest"].forEach((m) => {
          const o = document.createElement("option");
          o.value = o.textContent = m;
          plannerSel.appendChild(o);
        });
      });
  
    /* ─── websocket glue ─────────────────────────────────────── */
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsURL   = `${wsProto}//${location.hostname}:8000/ws`;
    let ws;
  
    const connect = () => {
      ws = new WebSocket(wsURL);
      ws.onopen    = () => chat.append("✓ connected\n");
      ws.onmessage = ({data}) => chat.append(data + "\n");
      ws.onclose   = () => setTimeout(connect, 3000);
    };
    connect();
  
    /* ─── send user query ────────────────────────────────────── */
    const push = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const payload = {
        query:         inp.value.trim(),
        planner_model: plannerSel.value,
        browser_model: browserSel ? browserSel.value : plannerSel.value,
        code_model:    codeSel    ? codeSel.value    : plannerSel.value,
      };
      ws.send(JSON.stringify(payload));
      inp.value = "";
    };
  
    send.onclick = push;
    inp.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); push(); }
    });
  });
  