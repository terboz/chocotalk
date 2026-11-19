(() => {
  "use strict";

  const APP_NAME = "chocotalk";
  const HOST_ID_KEY = "kc_host_id";
  const ROOMS_KEY = "kc_rooms";
  const MAX_IMAGE_DATA_URL_LENGTH = 240000;
  const MAX_NAME_LENGTH = 30;
  const MAX_ROOM_NAME_LENGTH = 50;
  const MAX_MESSAGE_LENGTH = 4000;
  const READ_DEBOUNCE_MS = 300;
  const MAX_RECONNECT_DELAY_MS = 15000;
  const STAMP_LIST = [
    "👍", "👏", "🙌", "😀", "😂",
    "🥰", "😍", "😎", "🤔", "😮",
    "😭", "🙏", "💪", "🎉", "✨",
    "❤️", "🔥", "🍵", "🍰", "🐱"
  ];
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  const state = {
    view: "loading",
    routeCode: "",
    roomCode: "",
    room: null,
    isHost: false,
    online: 0,
    closed: false,
    joined: false,
    clientId: "",
    selfName: "",
    self: null,
    messages: [],
    members: [],
    reads: [],
    settings: { readReceipts: false },
    socket: null,
    wsStatus: "idle",
    reconnectAttempt: 0,
    reconnectTimer: null,
    suppressReconnect: false,
    readTimer: null,
    lastReadSentId: null,
    unread: 0,
    pendingNew: 0,
    hasWelcomed: false,
    menuOpen: false,
    sendingImage: false,
    sendingTimer: null
  };

  const ui = {
    app: null,
    messages: null,
    newButton: null,
    input: null,
    sendButton: null,
    stampButton: null,
    imageButton: null,
    stampPopover: null,
    fileInput: null,
    composerError: null,
    sending: null,
    connBadge: null,
    onlineLabel: null,
    reconnectBanner: null,
    menuLayer: null,
    menuMembers: null,
    menuNameInput: null,
    closedOverlay: null,
    qrLayer: null,
    scanLayer: null,
    lightbox: null,
    toastStack: null
  };

  let routeToken = 0;
  let composerComposing = false;
  let composerCompositionEndedAt = 0;
  let mediaObserver = null;
  const mediaRequests = new Map();

  /* ---------- storage ---------- */

  function makeId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch (_error) {
      /* fall through */
    }
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
        return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
      }
    } catch (_error) {
      /* fall through */
    }
    return `kc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function localGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function localSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {
      /* storage may be unavailable */
    }
  }

  function sessionGet(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function sessionSet(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (_error) {
      /* storage may be unavailable */
    }
  }

  function getHostId() {
    let hostId = localGet(HOST_ID_KEY);
    if (!hostId) {
      hostId = makeId();
      localSet(HOST_ID_KEY, hostId);
    }
    return hostId;
  }

  function readRoomHistory() {
    const raw = localGet(ROOMS_KEY);
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((entry) => (
        entry && typeof entry.code === "string" && entry.code.trim() !== ""
      )).map((entry) => ({
        code: String(entry.code),
        name: typeof entry.name === "string" ? entry.name : String(entry.code),
        hostName: typeof entry.hostName === "string" ? entry.hostName : "",
        createdAt: entry.createdAt || ""
      }));
    } catch (_error) {
      return [];
    }
  }

  function saveRoomHistory(entries) {
    localSet(ROOMS_KEY, JSON.stringify(entries));
  }

  function addRoomToHistory(entry) {
    const entries = readRoomHistory().filter((item) => item.code !== entry.code);
    entries.unshift({
      code: entry.code,
      name: entry.name || entry.code,
      hostName: entry.hostName || "",
      createdAt: entry.createdAt || Date.now()
    });
    saveRoomHistory(entries.slice(0, 50));
  }

  function removeRoomFromHistory(code) {
    saveRoomHistory(readRoomHistory().filter((item) => item.code !== code));
  }

  /* ---------- DOM helpers ---------- */

  function h(tag, options, ...children) {
    const config = options || {};
    const node = document.createElement(tag);

    if (config.className) {
      node.className = config.className;
    }
    if (config.text !== undefined && config.text !== null) {
      node.textContent = String(config.text);
    }
    if (config.attrs) {
      Object.keys(config.attrs).forEach((name) => {
        const value = config.attrs[name];
        if (value !== undefined && value !== null && value !== false) {
          node.setAttribute(name, value === true ? "" : String(value));
        }
      });
    }
    if (config.props) {
      Object.keys(config.props).forEach((name) => {
        node[name] = config.props[name];
      });
    }
    if (config.dataset) {
      Object.keys(config.dataset).forEach((name) => {
        node.dataset[name] = String(config.dataset[name]);
      });
    }
    if (config.style) {
      Object.keys(config.style).forEach((name) => {
        node.style[name] = config.style[name];
      });
    }

    const appendChildren = (items) => {
      items.forEach((child) => {
        if (child === undefined || child === null || child === false) {
          return;
        }
        if (Array.isArray(child)) {
          appendChildren(child);
          return;
        }
        if (child instanceof Node) {
          node.appendChild(child);
        } else {
          node.appendChild(document.createTextNode(String(child)));
        }
      });
    };
    appendChildren(children);
    return node;
  }

  function clearNode(node) {
    if (node) {
      node.replaceChildren();
    }
  }

  function focusWithoutScroll(element) {
    if (!element) return;
    try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
  }

  function initials(name) {
    const chars = Array.from((name || "").trim());
    if (!chars.length) {
      return "?";
    }
    return chars[0].toUpperCase();
  }

  function brandBlock(options) {
    const config = options || {};
    return h(
      "div",
      { className: "brand" },
      h("span", {
        className: config.large ? "brand-mark large" : "brand-mark",
        attrs: { "aria-hidden": "true" },
        text: "c"
      }),
      h(
        "span",
        null,
        h("span", { className: "brand-name", text: APP_NAME }),
        h("span", { className: "brand-sub", text: "ルームチャット" })
      )
    );
  }

  function setFormError(element, message) {
    if (!element) {
      return;
    }
    if (message) {
      element.textContent = message;
      element.hidden = false;
    } else {
      element.textContent = "";
      element.hidden = true;
    }
  }

  function setBusy(button, busy, label, normalLabel) {
    if (!button) {
      return;
    }
    button.disabled = busy;
    button.textContent = busy ? label : normalLabel;
  }

  /* ---------- dates ---------- */

  function toDate(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date;
  }

  function timeText(value) {
    const date = toDate(value);
    if (!date) {
      return "";
    }
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function dayKey(value) {
    const date = toDate(value);
    if (!date) {
      return "";
    }
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function dateDividerText(value) {
    const date = toDate(value);
    if (!date) {
      return "";
    }
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`;
  }

  function shortDateText(value) {
    const date = toDate(value);
    if (!date) {
      return "";
    }
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  /* ---------- API ---------- */

  async function parseJsonResponse(response) {
    const text = await response.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  async function apiRequest(path, options) {
    const config = options || {};
    const headers = Object.assign({ Accept: "application/json" }, config.headers || {});
    const request = {
      method: config.method || "GET",
      headers
    };
    if (config.body !== undefined) {
      headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(config.body);
    }

    const response = await fetch(path, request);
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      let message = `通信に失敗しました（${response.status}）`;
      if (data && typeof data.message === "string" && data.message) {
        message = data.message;
      } else if (data && typeof data.error === "string" && data.error) {
        message = data.error;
      }
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function fetchRoomInfo(code) {
    const url = `/api/rooms/${encodeURIComponent(code)}?hostId=${encodeURIComponent(getHostId())}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (response.status === 404) {
      return null;
    }
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      let message = `ルーム情報を取得できませんでした（${response.status}）`;
      if (data && typeof data.message === "string" && data.message) {
        message = data.message;
      } else if (data && typeof data.error === "string" && data.error) {
        message = data.error;
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  /* ---------- title / routing ---------- */

  function updateDocumentTitle() {
    if (state.view === "chat" && state.room) {
      document.title = state.unread > 0
        ? `(${state.unread}) ${state.room.name}`
        : state.room.name;
      return;
    }
    if (state.room && (state.view === "join" || state.view === "closed" || state.view === "error")) {
      document.title = `${state.room.name} | ${APP_NAME}`;
      return;
    }
    document.title = APP_NAME;
  }

  function homePath() {
    return state.isHost ? "/host" : "/";
  }

  function parsePath(pathname) {
    const match = /^\/r\/([^/]+)\/?$/.exec(pathname);
    if (match) {
      try {
        return { name: "room", code: decodeURIComponent(match[1]) };
      } catch (_error) {
        return { name: "notfound" };
      }
    }
    if (pathname === "/host" || pathname === "/host/") {
      return { name: "host" };
    }
    if (pathname === "/" || pathname === "/index.html") {
      return { name: "home" };
    }
    return { name: "home" };
  }

  function navigate(path) {
    const next = path || "/";
    if (window.location.pathname + window.location.search !== next) {
      window.history.pushState({ kc: true }, "", next);
    }
    applyRoute();
  }

  function applyRoute() {
    closeMenu();
    closeQrDialog();
    closeQrScanner();
    closeLightbox();
    hideStampPopover();
    closeRoomNotifications();
    teardownRoom();

    const token = ++routeToken;
    const route = parsePath(window.location.pathname);
    state.unread = 0;

    if (route.name === "room") {
      state.routeCode = route.code;
      renderRoomLoading(token);
      loadRoom(route.code, token);
      return;
    }

    if (route.name === "host") {
      state.view = "home";
      state.room = null;
      state.roomCode = "";
      document.title = `ルームを管理 | ${APP_NAME}`;
      renderHome(token, "host");
      return;
    }

    state.view = "home";
    state.room = null;
    state.roomCode = "";
    document.title = `${APP_NAME} | ルームに参加`;
    renderHome(token, "guest");
  }

  /* ---------- home ---------- */

  function renderHome(token, mode) {
    state.view = "home";
    const isHostHome = mode === "host";
    clearNode(ui.app);

    const screen = h("section", { className: "home-screen", attrs: { "aria-label": isHostHome ? "ホストホーム" : "ゲストホーム" } });
    const inner = h("div", { className: "home-inner" });

    const switchLink = h("a", {
      className: "home-switch-link",
      attrs: { href: isHostHome ? "/" : "/host", hidden: !isHostHome },
      text: isHostHome ? "ゲストの方はこちら" : "ホストの方はこちら"
    });
    switchLink.addEventListener("click", (event) => {
      event.preventDefault();
      navigate(isHostHome ? "/" : "/host");
    });

    inner.appendChild(h(
      "header",
      { className: "home-topbar" },
      brandBlock(),
      switchLink
    ));

    const hero = isHostHome
      ? h(
        "div",
        { className: "home-hero" },
        h("h1", null, "ルームを", h("span", { className: "accent", text: "管理" })),
        h("p", { text: "ルームの作成と、このブラウザで作成したルームの管理ができます。" })
      )
      : h(
        "div",
        { className: "home-hero" },
        h(
          "h1",
          null,
          "ルームコードで、",
          h("br"),
          h("span", { className: "accent", text: "すぐ話そう。" })
        ),
        h("p", { text: "QR コードまたはルームコードで参加できます。アカウント登録は不要です。" })
      );

    const createError = h("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
    const createButton = h("button", {
      className: "btn btn-primary btn-block",
      attrs: { type: "submit" },
      text: "ルームを作る"
    });
    const nameInput = h("input", {
      className: "text-input",
      attrs: {
        type: "text",
        placeholder: "例：ゆき",
        autocomplete: "nickname",
        maxlength: String(MAX_NAME_LENGTH),
        required: true
      }
    });
    const roomNameInput = h("input", {
      className: "text-input",
      attrs: {
        type: "text",
        placeholder: "例：週末の作戦会議",
        autocomplete: "off",
        maxlength: String(MAX_ROOM_NAME_LENGTH),
        required: true
      }
    });
    const createForm = h(
      "form",
      { className: "stack-form", attrs: { novalidate: true } },
      createError,
      h(
        "div",
        { className: "field" },
        h("label", { className: "field-label", attrs: { for: "home-host-name" }, text: "あなたの名前" }),
        nameInput
      ),
      h(
        "div",
        { className: "field" },
        h("label", { className: "field-label", attrs: { for: "home-room-name" }, text: "ルーム名" }),
        roomNameInput,
        h("span", { className: "field-hint", text: "あとからメンバーに共有できる合言葉です。" })
      ),
      h("div", { className: "form-footer" }, createButton)
    );
    nameInput.id = "home-host-name";
    roomNameInput.id = "home-room-name";

    const createCard = h(
      "div",
      { className: "panel-card form-card" },
      h(
        "div",
        { className: "card-heading" },
        h(
          "div",
          null,
          h("h2", { text: "新しいルーム" }),
          h("p", { text: "ホストとしてルームを開きます。" })
        ),
        h("span", { className: "card-icon", attrs: { "aria-hidden": "true" }, text: "＋" })
      ),
      createForm
    );

    const joinError = h("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
    const codeInput = h("input", {
      className: "text-input",
      attrs: {
        type: "text",
        placeholder: "例：AB12CD",
        autocomplete: "off",
        autocapitalize: "characters",
        spellcheck: "false",
        maxlength: "64",
        required: true
      }
    });
    codeInput.id = "home-room-code";
    const joinButton = h("button", {
      className: "btn btn-block",
      attrs: { type: "submit" },
      text: "参加する"
    });
    const scanButton = h("button", {
      className: "btn btn-ghost btn-block",
      attrs: { type: "button" },
      text: "QRコードを読み取る"
    });
    scanButton.addEventListener("click", openQrScanner);
    const isMobile = isMobileGuest();
    const joinForm = h(
      "form",
      { className: "stack-form", attrs: { novalidate: true } },
      joinError,
      h(
        "div",
        { className: "field" },
        h("label", { className: "field-label", attrs: { for: "home-room-code" }, text: "ルームコード" }),
        codeInput,
        h("span", { className: "field-hint", text: "ホストから共有されたコードを入力してください。" })
      ),
      h("div", { className: "form-footer" }, isMobile ? [joinButton, scanButton] : [joinButton])
    );

    const joinCard = h(
      "div",
      { className: "panel-card form-card" },
      h(
        "div",
        { className: "card-heading" },
        h(
          "div",
          null,
          h("h2", { text: "コードで参加" }),
          h("p", { text: "すでにルームを案内されている方。" })
        ),
        h("span", { className: "card-icon", attrs: { "aria-hidden": "true" }, text: "#" })
      ),
      joinForm
    );

    const content = isHostHome
      ? h("div", { className: "home-host-form" }, createCard)
      : h("div", { className: "home-guest-panel" }, joinCard);

    const history = readRoomHistory();
    const refreshButton = h("button", {
      className: "btn btn-ghost btn-small",
      attrs: { type: "button" },
      text: "状態を再確認"
    });
    const roomsList = h("div", { className: "rooms-list" });

    if (!history.length) {
      roomsList.appendChild(h("div", {
        className: "empty-state",
        text: "まだ作成したルームはありません。上のフォームから最初のルームを作ってみましょう。"
      }));
    }

    const rows = [];
    history.forEach((entry) => {
      const status = h("span", {
        className: "badge status-pill",
        text: "確認中…"
      });
      const openButton = h("button", {
        className: "btn btn-small",
        attrs: { type: "button", disabled: true },
        text: "開く"
      });
      const deleteButton = h("button", {
        className: "btn btn-danger btn-small",
        attrs: { type: "button" },
        text: "削除"
      });
      const nameLabel = h("span", { className: "room-row-name", text: entry.name });
      const row = h(
        "div",
        { className: "room-row", dataset: { roomCode: entry.code } },
        h(
          "div",
          { className: "room-row-main" },
          h("div", { className: "room-row-title" }, nameLabel),
          h(
            "div",
            { className: "room-row-meta" },
            h("span", { className: "room-code", text: `コード: ${entry.code}` }),
            entry.hostName ? h("span", { text: `ホスト: ${entry.hostName}` }) : null
          )
        ),
        h("div", { className: "room-row-side" }, status, openButton, deleteButton)
      );

      openButton.addEventListener("click", () => {
        if (!openButton.disabled) {
          navigate(`/r/${encodeURIComponent(entry.code)}`);
        }
      });
      deleteButton.addEventListener("click", () => {
        deleteRoomFromHome(entry, row, deleteButton, roomsList);
      });
      roomsList.appendChild(row);
      rows.push({ entry, status, openButton, nameLabel });
    });

    const roomsSection = h(
      "section",
      { className: "rooms-section" },
      h(
        "div",
        { className: "section-heading" },
        h(
          "div",
          null,
          h("h2", { text: "あなたのルーム" }),
          h("p", { text: "このブラウザで作成したルームの一覧です。" })
        ),
        refreshButton
      ),
      roomsList
    );

    inner.appendChild(hero);
    inner.appendChild(content);
    if (isHostHome) {
      inner.appendChild(roomsSection);
    }
    inner.appendChild(h(
      "footer",
      { className: "home-footer" },
      h("div", { text: APP_NAME + " — 身内だけでつかえるルームチャット" }),
      h("div", { text: "ルームコードを知っている人だけが参加できます。" })
    ));

    screen.appendChild(inner);
    ui.app.appendChild(screen);

    createForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setFormError(createError, "");
      const hostName = nameInput.value.trim();
      const roomName = roomNameInput.value.trim();

      if (!hostName) {
        setFormError(createError, "あなたの名前を入力してください。");
        focusWithoutScroll(nameInput);
        return;
      }
      if (Array.from(hostName).length > MAX_NAME_LENGTH) {
        setFormError(createError, `名前は${MAX_NAME_LENGTH}文字以内で入力してください。`);
        return;
      }
      if (!roomName) {
        setFormError(createError, "ルーム名を入力してください。");
        focusWithoutScroll(roomNameInput);
        return;
      }
      if (Array.from(roomName).length > MAX_ROOM_NAME_LENGTH) {
        setFormError(createError, `ルーム名は${MAX_ROOM_NAME_LENGTH}文字以内で入力してください。`);
        return;
      }

      setBusy(createButton, true, "作成中…", "ルームを作る");
      try {
        const data = await apiRequest("/api/rooms", {
          method: "POST",
          body: {
            roomName,
            hostName,
            hostId: getHostId()
          }
        });
        const room = data && data.room ? data.room : {};
        const code = (data && data.code) || room.code;
        if (!code) {
          throw new Error("ルームの作成に失敗しました。");
        }
        addRoomToHistory({
          code: String(code),
          name: room.name || roomName,
          hostName: room.hostName || hostName,
          createdAt: room.createdAt || Date.now()
        });
        navigate(`/r/${encodeURIComponent(String(code))}`);
      } catch (error) {
        setFormError(createError, error && error.message ? error.message : "ルームを作成できませんでした。");
        setBusy(createButton, false, "作成中…", "ルームを作る");
      }
    });

    joinForm.addEventListener("submit", (event) => {
      event.preventDefault();
      setFormError(joinError, "");
      const code = codeInput.value.trim();
      if (!code) {
        setFormError(joinError, "ルームコードを入力してください。");
        focusWithoutScroll(codeInput);
        return;
      }
      navigate(`/r/${encodeURIComponent(code)}`);
    });

    refreshButton.addEventListener("click", () => {
      refreshButton.disabled = true;
      refreshButton.textContent = "確認中…";
      refreshHomeRoomStatuses(token, rows).finally(() => {
        if (token === routeToken) {
          refreshButton.disabled = false;
          refreshButton.textContent = "状態を再確認";
        }
      });
    });

    if (isHostHome) {
      refreshHomeRoomStatuses(token, rows);
    }
  }

  async function refreshHomeRoomStatuses(token, rows) {
    await Promise.all(rows.map(async (row) => {
      try {
        const info = await fetchRoomInfo(row.entry.code);
        if (token !== routeToken) {
          return;
        }
        if (!info || !info.room) {
          row.status.textContent = "利用できません";
          row.status.className = "badge status-pill badge-closed";
          row.openButton.hidden = true;
          return;
        }
        if (info.room.name && row.nameLabel.textContent !== info.room.name) {
          row.nameLabel.textContent = info.room.name;
        }
        if (info.room.closed) {
          row.status.textContent = "閉じています";
          row.status.className = "badge status-pill badge-closed";
          row.openButton.hidden = true;
        } else {
          row.status.textContent = "開いています";
          row.status.className = "badge status-pill badge-open";
          row.openButton.hidden = false;
          row.openButton.disabled = false;
        }
      } catch (_error) {
        if (token !== routeToken) {
          return;
        }
        row.status.textContent = "状態不明";
        row.status.className = "badge status-pill";
        row.openButton.hidden = false;
        row.openButton.disabled = false;
      }
    }));
  }

  async function deleteRoomFromHome(entry, row, button, roomsList) {
    const confirmed = window.confirm(`「${entry.name}」を削除しますか？\nメッセージ履歴は復元できません。`);
    if (!confirmed) {
      return;
    }

    button.disabled = true;
    button.textContent = "削除中…";
    try {
      await apiRequest(`/api/rooms/${encodeURIComponent(entry.code)}/delete`, {
        method: "POST",
        body: { hostId: getHostId() }
      });
      removeRoomEntryFromHome(entry, row, roomsList);
      showToast("ルームを削除しました。", "success");
    } catch (error) {
      if (error && error.status === 404) {
        removeRoomEntryFromHome(entry, row, roomsList);
        showToast("ルームを削除しました。", "success");
      } else if (error && error.status === 403) {
        showToast("ホスト権限がありません", "error");
      } else {
        showToast(error && error.message ? error.message : "ルームを削除できませんでした。", "error");
      }
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "削除";
      }
    }
  }

  function removeRoomEntryFromHome(entry, row, roomsList) {
    removeRoomFromHistory(entry.code);
    if (row.isConnected) {
      row.remove();
    }
    updateRoomsEmptyState(roomsList);
  }

  function updateRoomsEmptyState(roomsList) {
    if (!roomsList) {
      return;
    }
    if (roomsList.querySelector(".room-row")) {
      const empty = roomsList.querySelector(".empty-state");
      if (empty) {
        empty.remove();
      }
      return;
    }
    if (!roomsList.querySelector(".empty-state")) {
      roomsList.appendChild(h("div", {
        className: "empty-state",
        text: "まだ作成したルームはありません。上のフォームから最初のルームを作ってみましょう。"
      }));
    }
  }

  /* ---------- room boot ---------- */

  function teardownRoom() {
    state.suppressReconnect = true;
    if (mediaObserver) {
      mediaObserver.disconnect();
      mediaObserver = null;
    }
    mediaRequests.clear();
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.readTimer) {
      window.clearTimeout(state.readTimer);
      state.readTimer = null;
    }
    if (state.sendingTimer) {
      window.clearTimeout(state.sendingTimer);
      state.sendingTimer = null;
    }
    if (state.socket) {
      const socket = state.socket;
      state.socket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, "navigation");
      } catch (_error) {
        /* ignore */
      }
    }

    state.joined = false;
    state.closed = false;
    state.room = null;
    state.roomCode = "";
    state.routeCode = "";
    state.isHost = false;
    state.online = 0;
    state.self = null;
    state.clientId = "";
    state.selfName = "";
    state.messages = [];
    state.members = [];
    state.reads = [];
    state.settings = { readReceipts: false };
    state.wsStatus = "idle";
    state.reconnectAttempt = 0;
    state.lastReadSentId = null;
    state.pendingNew = 0;
    state.hasWelcomed = false;
    state.sendingImage = false;
    state.menuOpen = false;
    state.suppressReconnect = false;

    ui.messages = null;
    ui.newButton = null;
    ui.input = null;
    ui.sendButton = null;
    ui.stampButton = null;
    ui.imageButton = null;
    ui.stampPopover = null;
    ui.fileInput = null;
    ui.composerError = null;
    ui.sending = null;
    ui.connBadge = null;
    ui.onlineLabel = null;
    ui.reconnectBanner = null;
    ui.menuLayer = null;
    ui.menuMembers = null;
    ui.menuNameInput = null;
    ui.closedOverlay = null;
  }

  function normalizeSettings(settings) {
    return {
      readReceipts: !!(settings && settings.readReceipts)
    };
  }

  function plainScreenBase(backPath) {
    const screen = h("section", { className: "plain-screen" });
    const topbar = h(
      "div",
      { className: "plain-topbar" },
      brandBlock(),
      h(
        "button",
        { className: "back-btn", attrs: { type: "button" } },
        h("span", { attrs: { "aria-hidden": "true" }, text: "←" }),
        h("span", { text: "ホーム" })
      )
    );
    topbar.querySelector("button").addEventListener("click", () => navigate(backPath || "/"));
    const center = h("div", { className: "plain-center" });
    screen.appendChild(topbar);
    screen.appendChild(center);
    return { screen, center };
  }

  function renderRoomLoading(token) {
    state.view = "loading";
    document.title = APP_NAME;
    clearNode(ui.app);
    const base = plainScreenBase();
    base.center.appendChild(h(
      "div",
      { className: "loading-box", attrs: { role: "status" } },
      h("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
      h("span", { text: "ルームを読み込んでいます…" })
    ));
    ui.app.appendChild(base.screen);
    return token;
  }

  async function loadRoom(code, token) {
    try {
      const data = await fetchRoomInfo(code);
      if (token !== routeToken) {
        return;
      }
      if (!data || !data.room) {
        renderRoomNotFound();
        return;
      }

      const room = data.room;
      const canonicalCode = room.code ? String(room.code) : code;
      if (canonicalCode && canonicalCode !== code) {
        window.history.replaceState(window.history.state, "", `/r/${encodeURIComponent(canonicalCode)}`);
      }

      state.room = room;
      state.roomCode = canonicalCode;
      state.routeCode = canonicalCode;
      state.isHost = !!data.isHost;
      state.online = Number(data.online) > 0 ? Number(data.online) : 0;
      state.closed = !!room.closed;
      state.settings = normalizeSettings(room.settings);
      state.hasWelcomed = false;
      state.messages = [];
      state.members = [];
      state.reads = [];
      state.pendingNew = 0;
      state.unread = 0;
      updateDocumentTitle();

      if (state.closed) {
        renderRoomClosedScreen();
        return;
      }

      const savedClientId = sessionGet(`kc_cid_${canonicalCode}`);
      const savedName = sessionGet(`kc_name_${canonicalCode}`);
      if (savedClientId && savedName) {
        state.clientId = savedClientId;
        state.selfName = savedName;
        startChat();
      } else {
        renderJoinCard(savedName || "");
      }
    } catch (error) {
      if (token !== routeToken) {
        return;
      }
      renderRoomLoadError(error);
    }
  }

  function renderRoomNotFound() {
    state.view = "notfound";
    state.room = null;
    document.title = APP_NAME;
    clearNode(ui.app);
    const base = plainScreenBase();
    base.center.appendChild(h(
      "div",
      { className: "plain-card narrow" },
      h("span", { className: "plain-icon", attrs: { "aria-hidden": "true" }, text: "？" }),
      h("h1", { text: "ルームが見つかりません" }),
      h("p", { text: "ルームコードが間違っているか、ルームが削除された可能性があります。コードを確認してもう一度お試しください。" }),
      h(
        "div",
        { className: "plain-actions" },
        h("button", {
          className: "btn btn-primary",
          attrs: { type: "button" },
          text: "ホームへ戻る",
          props: { onclick: () => navigate("/") }
        })
      )
    ));
    ui.app.appendChild(base.screen);
  }

  function renderRoomLoadError(error) {
    state.view = "error";
    document.title = APP_NAME;
    clearNode(ui.app);
    const base = plainScreenBase();
    const retry = h("button", {
      className: "btn btn-primary",
      attrs: { type: "button" },
      text: "再試行"
    });
    retry.addEventListener("click", () => {
      const token = ++routeToken;
      renderRoomLoading(token);
      loadRoom(state.routeCode, token);
    });
    base.center.appendChild(h(
      "div",
      { className: "plain-card narrow" },
      h("span", { className: "plain-icon danger", attrs: { "aria-hidden": "true" }, text: "!" }),
      h("h1", { text: "ルームを読み込めません" }),
      h("p", { text: error && error.message ? error.message : "通信状況を確認して、もう一度お試しください。" }),
      h(
        "div",
        { className: "plain-actions" },
        retry,
        h("button", {
          className: "btn btn-ghost",
          attrs: { type: "button" },
          text: "ホームへ",
          props: { onclick: () => navigate("/") }
        })
      )
    ));
    ui.app.appendChild(base.screen);
  }

  function renderRoomClosedScreen() {
    state.view = "closed";
    updateDocumentTitle();
    clearNode(ui.app);
    const base = plainScreenBase(homePath());
    const roomName = state.room ? state.room.name : "このルーム";
    base.center.appendChild(h(
      "div",
      { className: "plain-card narrow" },
      h("span", { className: "plain-icon danger", attrs: { "aria-hidden": "true" }, text: "×" }),
      h("h1", { text: "ホストがこのルームを閉じました" }),
      h("p", { text: `${roomName} は閉じられました。新しいルームを作るか、別のルームコードで参加してください。` }),
      h(
        "div",
        { className: "plain-actions" },
        h("button", {
          className: "btn btn-primary",
          attrs: { type: "button" },
          text: "ホームへ戻る",
          props: { onclick: () => navigate(homePath()) }
        })
      )
    ));
    ui.app.appendChild(base.screen);
  }

  function renderJoinCard(previousName) {
    state.view = "join";
    updateDocumentTitle();
    clearNode(ui.app);

    const base = plainScreenBase(homePath());
    const card = h("div", { className: "plain-card" });
    const defaultName = state.isHost
      ? (state.room && state.room.hostName) || previousName || ""
      : previousName || "";

    const errorElement = h("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
    const nameInput = h("input", {
      className: "text-input",
      attrs: {
        type: "text",
        placeholder: "表示名を入力",
        autocomplete: "nickname",
        maxlength: String(MAX_NAME_LENGTH),
        required: true
      },
      props: { value: defaultName }
    });
    nameInput.id = "join-name";
    const joinButton = h("button", {
      className: "btn btn-primary btn-block",
      attrs: { type: "submit" },
      text: "参加する"
    });

    card.appendChild(h("span", {
      className: "plain-icon",
      attrs: { "aria-hidden": "true" },
      text: "#"
    }));
    card.appendChild(h("h1", { text: state.room.name }));
    card.appendChild(h("p", { text: "ルームに参加して、チャットを始めましょう。" }));

    const summary = h(
      "div",
      { className: "room-summary" },
      h(
        "div",
        { className: "room-summary-row" },
        h("span", { className: "room-summary-label", text: "ホスト" }),
        h("span", { className: "room-summary-value", text: state.room.hostName || "—" })
      ),
      h(
        "div",
        { className: "room-summary-row" },
        h("span", { className: "room-summary-label", text: "ルームコード" }),
        h("span", { className: "room-summary-value room-code", text: state.roomCode })
      ),
      h(
        "div",
        { className: "room-summary-row" },
        h("span", { className: "room-summary-label", text: "オンライン" }),
        h("span", { className: "room-summary-value", text: `${state.online}人` })
      )
    );
    card.appendChild(summary);

    const form = h(
      "form",
      { className: "stack-form", attrs: { novalidate: true } },
      errorElement,
      h(
        "div",
        { className: "field" },
        h("label", { className: "field-label", attrs: { for: "join-name" }, text: "あなたの表示名" }),
        nameInput,
        h("span", { className: "field-hint", text: state.isHost ? "ルームのホストとして参加します。" : "ほかの参加者に表示される名前です。" })
      ),
      h("div", { className: "form-footer" }, joinButton)
    );
    if (state.isHost) {
      card.appendChild(h("div", {
        className: "join-host-note",
        text: "あなたはこのルームのホストです。"
      }));
    }
    card.appendChild(form);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      setFormError(errorElement, "");
      const name = nameInput.value.trim();
      if (!name) {
        setFormError(errorElement, "表示名を入力してください。");
        focusWithoutScroll(nameInput);
        return;
      }
      if (Array.from(name).length > MAX_NAME_LENGTH) {
        setFormError(errorElement, `表示名は${MAX_NAME_LENGTH}文字以内で入力してください。`);
        return;
      }

      const clientKey = `kc_cid_${state.roomCode}`;
      const nameKey = `kc_name_${state.roomCode}`;
      let clientId = sessionGet(clientKey);
      if (!clientId) {
        clientId = makeId();
      }
      sessionSet(clientKey, clientId);
      sessionSet(nameKey, name);
      state.clientId = clientId;
      state.selfName = name;
      startChat();
    });

    base.center.appendChild(card);
    ui.app.appendChild(base.screen);
  }

  function startChat() {
    if (!state.room) {
      return;
    }
    state.view = "chat";
    state.joined = true;
    state.closed = false;
    state.hasWelcomed = false;
    updateDocumentTitle();
    renderChat();
    connectSocket();
  }

  /* ---------- chat shell ---------- */

  function renderChat() {
    clearNode(ui.app);
    const room = state.room;

    const screen = h("section", {
      className: "chat-screen",
      attrs: { "aria-label": `${room.name}のチャット` }
    });

    const connBadge = h("span", {
      className: "conn-badge",
      attrs: { role: "status", "aria-live": "polite" },
      text: "接続中"
    });
    const onlineLabel = h("span", { className: "online-label", text: `${state.online || 0}人オンライン` });
    const menuButton = h("button", {
      className: "icon-btn menu-btn",
      attrs: { type: "button", "aria-label": "メニューを開く" }
    }, h("span", { className: "menu-glyph", attrs: { "aria-hidden": "true" }, text: "☰" }));
    menuButton.addEventListener("click", openMenu);

    const header = h(
      "header",
      { className: "chat-header" },
      h(
        "div",
        { className: "chat-identity" },
        h("div", { className: "chat-room-name", text: room.name }),
        h("div", { className: "chat-sub" }, onlineLabel, connBadge)
      ),
      menuButton
    );

    const reconnectBanner = h(
      "div",
      { className: "reconnect-banner", attrs: { role: "status", "aria-live": "polite" }, props: { hidden: true } },
      h("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
      h("span", { text: "接続が切れました。再接続しています…" })
    );

    const messages = h("div", {
      className: "messages",
      attrs: {
        role: "log",
        "aria-live": "polite",
        "aria-relevant": "additions",
        "aria-label": "メッセージ一覧"
      }
    });
    const newButton = h("button", {
      className: "new-msg-btn",
      attrs: { type: "button" },
      props: { hidden: true },
      text: "新着メッセージ"
    });
    newButton.addEventListener("click", () => scrollToBottom(true));

    const messagesWrap = h("div", { className: "messages-wrap" }, messages, newButton);

    const composerError = h("div", {
      className: "composer-error",
      attrs: { role: "alert" },
      props: { hidden: true }
    });
    const sending = h(
      "div",
      { className: "composer-sending", attrs: { role: "status" }, props: { hidden: true } },
      h("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
      h("span", { text: "画像を送信中…" })
    );

    const stampPopover = h("div", {
      className: "stamp-popover",
      attrs: { role: "dialog", "aria-label": "スタンプ" },
      props: { hidden: true }
    });
    STAMP_LIST.forEach((stamp) => {
      const button = h("button", {
        className: "stamp-option",
        attrs: { type: "button", "aria-label": `スタンプ ${stamp}` },
        text: stamp
      });
      button.addEventListener("click", () => {
        hideStampPopover();
        if (sendSocketMessage({ kind: "stamp", text: stamp })) {
          focusWithoutScroll(ui.input);
        }
      });
      stampPopover.appendChild(button);
    });

    const fileInput = h("input", {
      attrs: { type: "file", accept: "image/*" },
      props: { hidden: true }
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (file) {
        handleImageFile(file);
      }
    });

    const stampButton = h("button", {
      className: "icon-btn",
      attrs: { type: "button", "aria-label": "スタンプを選ぶ", "aria-expanded": "false" }
    }, h("span", { attrs: { "aria-hidden": "true" }, text: "😊" }));
    stampButton.addEventListener("click", toggleStampPopover);

    const imageButton = h("button", {
      className: "icon-btn",
      attrs: { type: "button", "aria-label": "画像を送る" }
    }, h("span", { attrs: { "aria-hidden": "true" }, text: "🖼️" }));
    imageButton.addEventListener("click", () => fileInput.click());

    const textarea = h("textarea", {
      className: "composer-input",
      attrs: {
        rows: "1",
        placeholder: "メッセージを入力…",
        "aria-label": "メッセージ",
        enterkeyhint: "send",
        maxlength: String(MAX_MESSAGE_LENGTH),
        autocomplete: "off"
      }
    });
    const sendButton = h("button", {
      className: "send-btn",
      attrs: { type: "button" },
      text: "送信"
    });

    const tools = h("div", { className: "composer-tools" }, stampButton, imageButton);
    const row = h("div", { className: "composer-row" }, tools, textarea, sendButton);
    const composer = h(
      "div",
      { className: "composer" },
      sending,
      composerError,
      stampPopover,
      fileInput,
      row
    );

    const closedOverlay = h("div", {
      className: "closed-overlay",
      attrs: { role: "alertdialog", "aria-modal": "true", "aria-label": "ルーム終了" },
      props: { hidden: true }
    });

    screen.appendChild(header);
    screen.appendChild(reconnectBanner);
    screen.appendChild(messagesWrap);
    screen.appendChild(composer);
    screen.appendChild(closedOverlay);
    ui.app.appendChild(screen);

    ui.messages = messages;
    ui.newButton = newButton;
    ui.input = textarea;
    ui.input.addEventListener("focus", function () {
      if (ui.messages) {
        ui.messages.scrollTop = ui.messages.scrollHeight;
      }
    });
    ui.sendButton = sendButton;
    ui.stampButton = stampButton;
    ui.imageButton = imageButton;
    ui.stampPopover = stampPopover;
    ui.fileInput = fileInput;
    ui.composerError = composerError;
    ui.sending = sending;
    ui.connBadge = connBadge;
    ui.onlineLabel = onlineLabel;
    ui.reconnectBanner = reconnectBanner;
    ui.closedOverlay = closedOverlay;

    messages.addEventListener("scroll", () => {
      if (isNearBottom()) {
        state.pendingNew = 0;
        updateNewButton();
      }
    }, { passive: true });

    messages.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const image = target.closest("img.msg-image");
      if (image && image.src) {
        openLightbox(image.src, image.alt || "画像");
      }
    });

    textarea.addEventListener("compositionstart", () => {
      composerComposing = true;
      composerCompositionEndedAt = 0;
    });
    textarea.addEventListener("compositionend", () => {
      composerComposing = false;
      composerCompositionEndedAt = Date.now();
    });
    textarea.addEventListener("input", () => {
      resizeComposer();
      setComposerError("");
      updateComposerAvailability();
    });
    textarea.addEventListener("keydown", (event) => {
      const compositionJustEnded = composerCompositionEndedAt > 0 && Date.now() - composerCompositionEndedAt < 80;
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        !composerComposing &&
        !compositionJustEnded &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        sendTextMessage();
      }
    });
    sendButton.addEventListener("click", sendTextMessage);

    updatePresenceUI();
    updateConnectionUI();
    updateComposerAvailability();
    setClosedOverlayVisible(state.closed);
    renderMessagesAll();
  }

  /* ---------- messages ---------- */

  function isOwnMessage(message) {
    return !!message && String(message.clientId || "") === String(state.clientId || "") && state.clientId !== "";
  }

  function sameMessageId(left, right) {
    return String(left) === String(right);
  }

  function safeImageSource(value) {
    if (typeof value !== "string") {
      return "";
    }
    if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(value)) {
      return value;
    }
    return "";
  }

  function resetMediaObserver() {
    if (mediaObserver) {
      mediaObserver.disconnect();
      mediaObserver = null;
    }
  }

  function createMessageImage(source, name) {
    const image = h("img", {
      className: "msg-image",
      attrs: {
        src: source,
        alt: `${name || "ゲスト"}が送信した画像`,
        loading: "lazy",
        decoding: "async"
      }
    });
    image.addEventListener("load", () => {
      if (isNearBottom()) {
        scrollToBottom(false);
      }
    });
    return image;
  }

  function showMediaUnavailable(placeholder) {
    if (!placeholder || !placeholder.isConnected) {
      return;
    }
    placeholder.classList.remove("msg-media-loading");
    placeholder.classList.add("msg-media-error");
    placeholder.textContent = "画像を表示できません";
  }

  function cacheMessageMedia(message, source, failed) {
    if (!message) {
      return;
    }
    const current = state.messages.find((item) => sameMessageId(item.id, message.id));
    const targets = current && current !== message ? [message, current] : [message];
    targets.forEach((target) => {
      if (source) {
        target.media = source;
        if (target.hasMedia === undefined) {
          target.hasMedia = true;
        }
        if (target.mediaFailed !== undefined) {
          delete target.mediaFailed;
        }
      }
      if (failed) {
        target.mediaFailed = true;
      }
    });
  }

  function requestMessageMedia(message) {
    const roomCode = state.roomCode;
    if (!roomCode || !message || message.id === undefined || message.id === null) {
      return Promise.resolve("");
    }
    const key = `${roomCode}:${String(message.id)}`;
    const cached = mediaRequests.get(key);
    if (cached) {
      return cached;
    }

    const url = `/api/rooms/${encodeURIComponent(roomCode)}/messages/${encodeURIComponent(String(message.id))}/media`;
    const request = fetch(url, { headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) {
          return "";
        }
        const data = await response.json().catch(() => null);
        const raw = data && (data.media !== undefined ? data.media : (data.message && data.message.media));
        return safeImageSource(raw);
      })
      .catch(() => "");
    mediaRequests.set(key, request);
    return request;
  }

  function loadMessageMedia(message, placeholder) {
    if (!message || !placeholder || !placeholder.isConnected) {
      return;
    }
    if (state.closed) {
      showMediaUnavailable(placeholder);
      return;
    }
    const currentSource = safeImageSource(message.media);
    if (currentSource) {
      placeholder.replaceWith(createMessageImage(currentSource, message.name || "ゲスト"));
      return;
    }

    const roomCode = state.roomCode;
    requestMessageMedia(message).then((source) => {
      if (state.roomCode !== roomCode) {
        return;
      }
      if (!source) {
        cacheMessageMedia(message, "", true);
        if (!state.closed) {
          showMediaUnavailable(placeholder);
        }
        return;
      }
      cacheMessageMedia(message, source, false);
      if (!placeholder.isConnected) {
        return;
      }
      const image = createMessageImage(source, message.name || "ゲスト");
      placeholder.replaceWith(image);
      if (isNearBottom()) {
        scrollToBottom(false);
      }
    });
  }

  function observeMessageMedia(message, placeholder) {
    if (state.closed) {
      showMediaUnavailable(placeholder);
      return;
    }
    if (typeof IntersectionObserver !== "function") {
      loadMessageMedia(message, placeholder);
      return;
    }
    if (!mediaObserver) {
      mediaObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }
          const target = entry.target;
          mediaObserver.unobserve(target);
          const messageId = target.dataset.mediaMid;
          const current = state.messages.find((item) => String(item.id) === messageId);
          if (current) {
            loadMessageMedia(current, target);
          }
        });
      }, { root: ui.messages, rootMargin: "200px 0px" });
    }
    placeholder.dataset.mediaMid = String(message.id);
    mediaObserver.observe(placeholder);
  }

  function createDateDivider(message) {
    const text = dateDividerText(message && message.createdAt);
    return h(
      "div",
      { className: "date-divider", attrs: { role: "separator" }, dataset: { date: dayKey(message && message.createdAt) } },
      h("span", { text })
    );
  }

  function createMessageElement(message) {
    const own = isOwnMessage(message);
    const row = h("div", {
      className: own ? "msg-row own" : "msg-row",
      dataset: { mid: String(message.id), own: own ? "1" : "0" }
    });

    const time = timeText(message.createdAt);
    const name = message.name || (own ? state.selfName : "ゲスト");
    const timeNode = h("time", { className: "msg-time", text: time });
    const date = toDate(message.createdAt);
    if (date) {
      timeNode.setAttribute("datetime", date.toISOString());
    }
    const meta = h(
      "div",
      { className: "msg-meta" },
      h("span", { className: "msg-name", text: name }),
      timeNode
    );
    row.appendChild(meta);

    const hasImagePayload = message.kind === "image" && (message.media || message.hasMedia);
    const kind = message.kind === "stamp" ? "stamp" : (message.kind === "image" ? "image" : "text");
    let bubble;

    if (kind === "image") {
      const imageSource = safeImageSource(message.media);
      bubble = h("div", { className: "msg-bubble is-image" });
      if (imageSource) {
        bubble.appendChild(createMessageImage(imageSource, name));
      } else if (hasImagePayload && !message.mediaFailed) {
        const placeholder = h("p", {
          className: "msg-text msg-media-loading",
          attrs: { role: "status" },
          text: "画像を読み込み中…"
        });
        bubble.appendChild(placeholder);
        observeMessageMedia(message, placeholder);
      } else {
        bubble.appendChild(h("p", { className: "msg-text msg-media-error", text: "画像を表示できません" }));
      }
    } else if (kind === "stamp") {
      let stampText = "😊";
      if (typeof message.text === "string" && message.text.trim()) {
        stampText = message.text;
      } else if (typeof message.media === "string" && message.media.length <= 16) {
        stampText = message.media;
      }
      bubble = h("div", { className: "msg-bubble is-stamp" }, h("div", {
        className: "msg-stamp",
        attrs: { role: "img", "aria-label": stampText },
        text: stampText
      }));
    } else {
      bubble = h("div", { className: "msg-bubble" }, h("p", {
        className: "msg-text",
        text: typeof message.text === "string" ? message.text : ""
      }));
    }

    row.appendChild(bubble);

    if (own) {
      const readStatus = h("div", {
        className: "read-status",
        dataset: { mid: String(message.id) },
        props: { hidden: !state.settings.readReceipts }
      });
      row.appendChild(readStatus);
    }
    return row;
  }

  function renderMessagesAll() {
    if (!ui.messages) {
      return;
    }
    resetMediaObserver();
    clearNode(ui.messages);
    if (!state.messages.length) {
      ui.messages.appendChild(h(
        "div",
        { className: "empty-messages" },
        h("span", { className: "empty-emoji", attrs: { "aria-hidden": "true" }, text: "💬" }),
        h("span", { text: "まだメッセージはありません。" }),
        h("span", { text: "最初のひとことを送ってみましょう。" })
      ));
      return;
    }

    let previousDay = "";
    state.messages.forEach((message) => {
      const currentDay = dayKey(message.createdAt);
      if (currentDay && currentDay !== previousDay) {
        ui.messages.appendChild(createDateDivider(message));
        previousDay = currentDay;
      }
      ui.messages.appendChild(createMessageElement(message));
    });
    updateReadIndicators();
  }

  function appendMessageElement(message, previousMessage) {
    if (!ui.messages) {
      return;
    }
    const empty = ui.messages.querySelector(".empty-messages");
    if (empty) {
      empty.remove();
    }
    const previousDay = dayKey(previousMessage && previousMessage.createdAt);
    const currentDay = dayKey(message.createdAt);
    if (currentDay && currentDay !== previousDay) {
      ui.messages.appendChild(createDateDivider(message));
    }
    ui.messages.appendChild(createMessageElement(message));
    updateReadIndicators();
  }

  function isNearBottom(threshold) {
    if (!ui.messages) {
      return true;
    }
    const distance = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight;
    return distance <= (threshold === undefined ? 120 : threshold);
  }

  function scrollToBottom(smooth) {
    if (!ui.messages) {
      return;
    }
    state.pendingNew = 0;
    updateNewButton();
    const doScroll = () => {
      if (!ui.messages) {
        return;
      }
      ui.messages.scrollTo({
        top: ui.messages.scrollHeight,
        behavior: smooth ? "smooth" : "auto"
      });
    };
    window.requestAnimationFrame(doScroll);
    window.setTimeout(doScroll, 60);
  }

  function updateNewButton() {
    if (!ui.newButton) {
      return;
    }
    ui.newButton.hidden = state.pendingNew <= 0;
  }

  function onIncomingMessage(message) {
    if (!message || message.id === undefined || message.id === null) {
      return;
    }
    if (state.messages.some((existing) => sameMessageId(existing.id, message.id))) {
      return;
    }

    const nearBottom = isNearBottom();
    const own = isOwnMessage(message);
    const previous = state.messages.length ? state.messages[state.messages.length - 1] : null;
    state.messages.push(message);
    appendMessageElement(message, previous);
    updateEmptyMessages();

    if (own || nearBottom) {
      scrollToBottom(false);
    } else {
      state.pendingNew += 1;
      updateNewButton();
    }

    if (document.visibilityState === "visible") {
      state.unread = 0;
    } else if (!own) {
      state.unread += 1;
    }
    updateDocumentTitle();

    if (!own && document.visibilityState === "hidden") {
      showRoomNotification(message);
    }

    scheduleRead(READ_DEBOUNCE_MS);
  }

  function updateEmptyMessages() {
    if (!ui.messages) {
      return;
    }
    const empty = ui.messages.querySelector(".empty-messages");
    if (state.messages.length && empty) {
      empty.remove();
    }
  }

  function mergeMessages(incoming) {
    if (!Array.isArray(incoming)) {
      return;
    }
    const positions = new Map();
    state.messages.forEach((message, index) => {
      positions.set(String(message.id), index);
    });

    incoming.forEach((message) => {
      if (!message || message.id === undefined || message.id === null) {
        return;
      }
      const key = String(message.id);
      const index = positions.get(key);
      if (index === undefined) {
        positions.set(key, state.messages.length);
        state.messages.push(message);
        return;
      }

      const existing = state.messages[index];
      const merged = Object.assign({}, existing, message);
      if (message.media === null || message.media === undefined) {
        if (existing.media !== null && existing.media !== undefined) {
          merged.media = existing.media;
        }
      }
      if (message.hasMedia === undefined && existing.hasMedia !== undefined) {
        merged.hasMedia = existing.hasMedia;
      }
      if (message.mediaFailed === undefined && existing.mediaFailed !== undefined) {
        merged.mediaFailed = existing.mediaFailed;
      }
      state.messages[index] = merged;
    });
  }

  function readerHasReached(lastReadId, message) {
    const readNumber = Number(lastReadId);
    const messageNumber = Number(message.id);
    if (!Number.isFinite(readNumber) || !Number.isFinite(messageNumber)) {
      return false;
    }
    return readNumber >= messageNumber;
  }

  function updateReadIndicators() {
    if (!ui.messages) {
      return;
    }
    const nodes = ui.messages.querySelectorAll(".read-status");
    if (!state.settings.readReceipts) {
      nodes.forEach((node) => {
        node.hidden = true;
        node.textContent = "";
      });
      return;
    }

    const otherMembers = new Map();
    state.members.forEach((member) => {
      if (member && member.clientId && String(member.clientId) !== String(state.clientId)) {
        otherMembers.set(String(member.clientId), member);
      }
    });
    const totalOthers = otherMembers.size;

    nodes.forEach((node) => {
      if (!node.dataset.mid) {
        return;
      }
      const message = state.messages.find((item) => String(item.id) === node.dataset.mid);
      if (!message) {
        node.hidden = true;
        return;
      }
      const readClients = new Set();
      state.reads.forEach((read) => {
        if (!read || !read.clientId || String(read.clientId) === String(state.clientId)) {
          return;
        }
        if (readerHasReached(read.lastReadId, message)) {
          readClients.add(String(read.clientId));
        }
      });

      if (totalOthers <= 0) {
        node.hidden = true;
        node.textContent = "";
        return;
      }

      const count = readClients.size;
      node.hidden = false;
      if (count >= totalOthers) {
        node.textContent = "全員既読";
        node.classList.add("all-read");
      } else {
        node.textContent = `既読 ${count}`;
        node.classList.remove("all-read");
      }
    });
  }

  function clearUnread() {
    if (state.unread !== 0) {
      state.unread = 0;
      updateDocumentTitle();
    }
    closeRoomNotifications();
    setAppBadgeCount(0);
  }

  /* ---------- composer ---------- */

  function resizeComposer() {
    if (!ui.input) {
      return;
    }
    ui.input.style.height = "auto";
    const maxHeight = 140;
    const nextHeight = Math.min(ui.input.scrollHeight, maxHeight);
    ui.input.style.height = `${nextHeight}px`;
    ui.input.style.overflowY = ui.input.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function updateComposerAvailability() {
    if (!ui.input) {
      return;
    }
    const canSend = state.wsStatus === "open" && !state.closed;
    ui.input.disabled = state.closed;
    if (ui.sendButton) {
      ui.sendButton.disabled = !canSend || ui.input.value.trim() === "";
    }
    if (ui.stampButton) {
      ui.stampButton.disabled = !canSend;
    }
    if (ui.imageButton) {
      ui.imageButton.disabled = !canSend || state.sendingImage;
    }
  }

  function setComposerError(message) {
    if (!ui.composerError) {
      return;
    }
    ui.composerError.textContent = message || "";
    ui.composerError.hidden = !message;
  }

  function sendSocketMessage(message) {
    if (state.closed) {
      return false;
    }
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      showToast("接続が切れています。再接続をお待ちください。", "error");
      return false;
    }
    try {
      state.socket.send(JSON.stringify({ type: "send", message }));
      return true;
    } catch (_error) {
      showToast("メッセージを送信できませんでした。", "error");
      return false;
    }
  }

  function sendTextMessage() {
    if (!ui.input || state.closed) {
      return;
    }
    const text = ui.input.value.trim();
    if (!text) {
      return;
    }
    if (!sendSocketMessage({ kind: "text", text })) {
      return;
    }
    ui.input.value = "";
    resizeComposer();
    setComposerError("");
    updateComposerAvailability();
    focusWithoutScroll(ui.input);
  }

  function hideStampPopover() {
    if (!ui.stampPopover) {
      return;
    }
    ui.stampPopover.hidden = true;
    if (ui.stampButton) {
      ui.stampButton.classList.remove("is-active");
      ui.stampButton.setAttribute("aria-expanded", "false");
    }
  }

  function toggleStampPopover() {
    if (!ui.stampPopover || state.closed || state.wsStatus !== "open") {
      return;
    }
    const willShow = ui.stampPopover.hidden;
    if (!willShow) {
      hideStampPopover();
      return;
    }
    ui.stampPopover.hidden = false;
    ui.stampButton.classList.add("is-active");
    ui.stampButton.setAttribute("aria-expanded", "true");
  }

  /* ---------- image message ---------- */

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("画像を読み込めませんでした。別の画像を選んでください。"));
      };
      image.src = objectUrl;
    });
  }

  function renderJpeg(image, maxSide, quality) {
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    if (!naturalWidth || !naturalHeight) {
      throw new Error("画像のサイズを取得できませんでした。");
    }
    const scale = Math.min(1, maxSide / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("画像を加工できませんでした。");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", quality);
  }

  async function compressImage(file) {
    const image = await loadImageFromFile(file);
    let maxSide = 1280;
    let quality = 0.72;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const dataUrl = renderJpeg(image, maxSide, quality);
      if (dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) {
        return dataUrl;
      }
      if (quality > 0.4) {
        quality = Math.max(0.4, quality - 0.08);
      } else if (maxSide > 480) {
        maxSide = Math.max(480, Math.round(maxSide * 0.82));
      } else {
        break;
      }
    }
    throw new Error("画像が大きすぎます。別の画像を選んでください。");
  }

  function setSendingIndicator(visible) {
    state.sendingImage = visible;
    if (ui.sending) {
      ui.sending.hidden = !visible;
    }
    updateComposerAvailability();
  }

  async function handleImageFile(file) {
    if (!file || state.sendingImage || state.closed) {
      return;
    }
    if (!file.type || !file.type.startsWith("image/")) {
      setComposerError("画像ファイルを選んでください。");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setComposerError("画像ファイルが大きすぎます。25MB以下の画像を選んでください。");
      return;
    }

    const currentRoom = state.roomCode;
    setComposerError("");
    setSendingIndicator(true);
    try {
      const dataUrl = await compressImage(file);
      if (state.roomCode !== currentRoom || !state.joined) {
        return;
      }
      if (!dataUrl || dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
        throw new Error("画像が大きすぎます。別の画像を選んでください。");
      }
      if (!sendSocketMessage({ kind: "image", media: dataUrl })) {
        throw new Error("接続が切れているため、画像を送信できませんでした。");
      }
    } catch (error) {
      if (state.roomCode === currentRoom) {
        setComposerError(error && error.message ? error.message : "画像を送信できませんでした。");
      }
    } finally {
      if (state.roomCode === currentRoom) {
        setSendingIndicator(false);
      }
    }
  }

  /* ---------- full screen image preview ---------- */

  function openLightbox(source, alt) {
    closeLightbox();
    const layer = h(
      "div",
      { className: "lightbox", attrs: { role: "dialog", "aria-modal": "true", "aria-label": "画像プレビュー" } },
      h("img", {
        className: "lightbox-img",
        attrs: { src: source, alt: alt || "画像" }
      }),
      h("button", {
        className: "lightbox-close",
        attrs: { type: "button", "aria-label": "閉じる" },
        text: "×"
      })
    );
    layer.addEventListener("click", (event) => {
      if (event.target === layer) {
        closeLightbox();
      }
    });
    layer.querySelector(".lightbox-close").addEventListener("click", closeLightbox);
    document.body.appendChild(layer);
    ui.lightbox = layer;
    window.setTimeout(() => {
      const button = layer.querySelector(".lightbox-close");
      if (button) {
        focusWithoutScroll(button);
      }
    }, 0);
  }

  function closeLightbox() {
    if (ui.lightbox) {
      ui.lightbox.remove();
      ui.lightbox = null;
    }
  }

  /* ---------- connection state ---------- */

  function updateConnectionUI() {
    if (!ui.connBadge) {
      return;
    }
    const status = state.wsStatus;
    let label = "未接続";
    let className = "conn-badge";
    if (status === "connecting") {
      label = "接続中";
      className += " is-connecting";
    } else if (status === "open") {
      label = "接続済み";
      className += " is-open";
    } else if (status === "reconnecting") {
      label = "再接続中";
      className += " is-reconnecting";
    } else if (status === "closed") {
      label = "終了";
      className += " is-closed";
    }
    ui.connBadge.textContent = label;
    ui.connBadge.className = className;

    if (ui.reconnectBanner) {
      const showBanner = state.joined && !state.closed &&
        (status === "reconnecting" || (status === "connecting" && state.reconnectAttempt > 0));
      ui.reconnectBanner.hidden = !showBanner;
      if (showBanner) {
        const textNode = ui.reconnectBanner.querySelector("span:last-child");
        if (textNode) {
          const attempt = Math.max(1, state.reconnectAttempt);
          textNode.textContent = `接続が切れました。再接続しています…（${attempt}回目）`;
        }
      }
    }
    updateComposerAvailability();
  }

  function updatePresenceUI() {
    const count = state.hasWelcomed ? state.members.length : state.online;
    if (ui.onlineLabel) {
      ui.onlineLabel.textContent = `${count}人オンライン`;
    }
    if (state.menuOpen) {
      refreshMenuMembers();
    }
    updateReadIndicators();
  }

  /* ---------- read receipts ---------- */

  function canSendRead() {
    return state.joined &&
      !state.closed &&
      state.settings.readReceipts &&
      state.wsStatus === "open" &&
      document.visibilityState === "visible" &&
      document.hasFocus();
  }

  function scheduleRead(delay) {
    if (!state.settings.readReceipts || state.closed) {
      return;
    }
    if (state.readTimer) {
      window.clearTimeout(state.readTimer);
    }
    state.readTimer = window.setTimeout(sendLatestRead, Math.max(0, delay || 0));
  }

  function sendLatestRead() {
    state.readTimer = null;
    if (!canSendRead() || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const latest = state.messages[state.messages.length - 1];
    if (!latest || latest.id === undefined || latest.id === null) {
      return;
    }
    if (state.lastReadSentId !== null && sameMessageId(state.lastReadSentId, latest.id)) {
      return;
    }
    try {
      state.socket.send(JSON.stringify({ type: "read", lastReadId: latest.id }));
      state.lastReadSentId = String(latest.id);
    } catch (_error) {
      /* the socket will reconnect */
    }
  }

  /* ---------- notifications ---------- */

  let serviceWorkerPromise = null;

  let appBadgeCount = 0;

  function setAppBadgeCount(count) {
    appBadgeCount = Math.max(0, count);
    const nav = navigator;
    if (typeof nav.setAppBadge !== "function") {
      return;
    }
    try {
      if (appBadgeCount === 0 && typeof nav.clearAppBadge === "function") {
        Promise.resolve(nav.clearAppBadge()).catch(function () {});
      } else {
        Promise.resolve(nav.setAppBadge(appBadgeCount)).catch(function () {});
      }
    } catch (_error) {
      /* app badges are best-effort */
    }
  }

  function notificationsSupported() {
    return window.isSecureContext && "Notification" in window && "serviceWorker" in navigator;
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      return Promise.resolve(null);
    }
    if (!serviceWorkerPromise) {
      serviceWorkerPromise = navigator.serviceWorker.register("/sw.js").catch(() => {
        serviceWorkerPromise = null;
        return null;
      });
    }
    return serviceWorkerPromise;
  }

  async function requestNotifications() {
    if (!notificationsSupported()) {
      showToast("この環境では通知を利用できません。", "error");
      return;
    }

    let permission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch (_error) {
        permission = Notification.permission;
      }
    }

    if (permission === "granted") {
      const registration = await registerServiceWorker();
      if (!registration) {
        showToast("通知の準備に失敗しました。", "error");
        return;
      }
      showToast("通知を有効にしました。", "success");
    } else if (permission === "denied") {
      showToast("通知がブロックされています。ブラウザの設定をご確認ください。", "error");
    } else {
      showToast("通知は許可されませんでした。");
    }
    if (state.menuOpen) {
      refreshMenuNotificationLabel();
    }
  }

  function notificationBody(message) {
    const name = message.name || "ゲスト";
    let body;
    if (message.kind === "image") {
      body = "画像を送信しました";
    } else if (message.kind === "stamp") {
      body = typeof message.text === "string" && message.text.trim() ? message.text : "スタンプを送信しました";
    } else {
      body = typeof message.text === "string" ? message.text : "";
    }
    body = body.replace(/\s+/g, " ").trim();
    if (body.length > 120) {
      body = `${body.slice(0, 119)}…`;
    }
    return `${name}: ${body}`;
  }

  function showRoomNotification(message) {
    if (document.visibilityState !== "hidden" || state.closed || !state.room) {
      return;
    }
    setAppBadgeCount(appBadgeCount + 1);
    if (!notificationsSupported() || Notification.permission !== "granted") {
      return;
    }
    const title = state.room.name;
    const body = notificationBody(message);
    const tag = `kc-${state.roomCode}`;
    const url = `${window.location.origin}/r/${encodeURIComponent(state.roomCode)}`;
    registerServiceWorker().then((registration) => {
      if (!registration) {
        return null;
      }
      return registration.showNotification(title, {
        body,
        tag,
        icon: "/icons/icon.svg",
        data: { url }
      });
    }).catch(() => {
      /* notifications are best-effort */
    });
  }

  function closeRoomNotifications() {
    if (!notificationsSupported() || !state.roomCode) {
      return;
    }
    navigator.serviceWorker.getRegistration().then((registration) => {
      if (!registration) {
        return null;
      }
      return registration.getNotifications({ tag: `kc-${state.roomCode}` });
    }).then((notifications) => {
      if (notifications) {
        notifications.forEach((notification) => notification.close());
      }
    }).catch(() => {
      /* notifications are best-effort */
    });
  }

  /* ---------- closed room ---------- */

  function setClosedOverlayVisible(visible) {
    if (!ui.closedOverlay) {
      return;
    }
    if (!visible) {
      ui.closedOverlay.hidden = true;
      clearNode(ui.closedOverlay);
      return;
    }

    clearNode(ui.closedOverlay);
    const overlay = ui.closedOverlay;
    overlay.appendChild(h(
      "div",
      { className: "closed-card" },
      h("span", { className: "closed-icon", attrs: { "aria-hidden": "true" }, text: "×" }),
      h("h2", { text: "ホストがルームを閉じました" }),
      h("p", { text: "このルームではもうメッセージを送信できません。ご参加ありがとうございました。" }),
      h(
        "div",
        { className: "plain-actions" },
        h("button", {
          className: "btn btn-primary",
          attrs: { type: "button" },
          text: "ホームへ戻る",
          props: { onclick: () => navigate(homePath()) }
        })
      )
    ));
    overlay.hidden = false;
  }

  function handleRoomClosed() {
    if (state.closed) {
      return;
    }
    state.closed = true;
    state.suppressReconnect = true;
    state.wsStatus = "closed";
    state.pendingNew = 0;
    state.unread = 0;
    if (state.room) {
      state.room.closed = true;
    }
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.readTimer) {
      window.clearTimeout(state.readTimer);
      state.readTimer = null;
    }
    if (state.socket) {
      const socket = state.socket;
      state.socket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, "room closed");
      } catch (_error) {
        /* ignore */
      }
    }
    hideStampPopover();
    setClosedOverlayVisible(true);
    updateConnectionUI();
    updateComposerAvailability();
    updateNewButton();
    updateDocumentTitle();
    closeMenu();
  }

  /* ---------- WebSocket ---------- */

  function updateChatHeaderRoomName() {
    const nameElement = document.querySelector(".chat-room-name");
    if (nameElement && state.room) {
      nameElement.textContent = state.room.name;
    }
  }

  function connectSocket() {
    if (!state.joined || !state.room || state.closed) {
      return;
    }
    if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    params.set("name", state.selfName);
    params.set("clientId", state.clientId);
    params.set("hostId", getHostId());
    const url = `${protocol}//${window.location.host}/api/rooms/${encodeURIComponent(state.roomCode)}/ws?${params.toString()}`;

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (_error) {
      scheduleReconnect();
      return;
    }

    state.socket = socket;
    state.suppressReconnect = false;
    state.wsStatus = state.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    updateConnectionUI();

    socket.onopen = () => {
      if (state.socket !== socket) {
        return;
      }
      state.wsStatus = "open";
      state.reconnectAttempt = 0;
      updateConnectionUI();
    };

    socket.onmessage = (event) => {
      if (state.socket !== socket) {
        return;
      }
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_error) {
        return;
      }
      handleSocketMessage(data);
    };

    socket.onerror = () => {
      /* onclose handles reconnection */
    };

    socket.onclose = (event) => {
      if (state.socket !== socket) {
        return;
      }
      state.socket = null;
      if (event && event.code === 4000) {
        handleRoomClosed();
        return;
      }
      if (state.suppressReconnect || state.closed) {
        return;
      }
      state.wsStatus = "reconnecting";
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (!state.joined || state.closed) {
      return;
    }
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    const nextAttempt = state.reconnectAttempt + 1;
    const delay = Math.min(1000 * Math.pow(2, nextAttempt - 1), MAX_RECONNECT_DELAY_MS);
    state.reconnectAttempt = nextAttempt;
    state.wsStatus = "reconnecting";
    updateConnectionUI();
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      if (!state.joined || state.closed) {
        return;
      }
      connectSocket();
    }, delay);
  }

  function handleSocketMessage(data) {
    if (!data || typeof data !== "object") {
      return;
    }

    if (data.type === "welcome") {
      const firstWelcome = !state.hasWelcomed;
      const nearBottom = isNearBottom();
      const beforeCount = state.messages.length;

      if (data.room) {
        state.room = Object.assign({}, state.room, data.room);
        if (data.room.code) {
          state.roomCode = String(data.room.code);
        }
        updateChatHeaderRoomName();
      }
      if (data.self) {
        state.self = data.self;
        if (typeof data.self.name === "string" && data.self.name) {
          state.selfName = data.self.name;
          sessionSet(`kc_name_${state.roomCode}`, state.selfName);
        }
        if (data.self.role === "host") {
          state.isHost = true;
        }
      }
      if (Array.isArray(data.messages)) {
        mergeMessages(data.messages);
      }
      state.members = Array.isArray(data.members) ? data.members : [];
      state.reads = Array.isArray(data.reads) ? data.reads : [];
      const welcomeSettings = data.settings || (data.room && data.room.settings);
      if (welcomeSettings) {
        state.settings = normalizeSettings(welcomeSettings);
      }
      state.online = state.members.length;
      state.hasWelcomed = true;
      renderMessagesAll();
      updatePresenceUI();
      syncMenuSettings();
      updateDocumentTitle();

      const added = state.messages.length - beforeCount;
      if (!firstWelcome && !nearBottom && added > 0) {
        state.pendingNew += added;
        updateNewButton();
      }
      if (firstWelcome || nearBottom) {
        scrollToBottom(false);
      }

      if (state.room && state.room.closed) {
        handleRoomClosed();
        return;
      }
      scheduleRead(READ_DEBOUNCE_MS);
      return;
    }

    if (data.type === "message") {
      if (!state.closed) {
        onIncomingMessage(data.message);
      }
      return;
    }

    if (data.type === "presence") {
      state.members = Array.isArray(data.members) ? data.members : [];
      state.online = state.members.length;
      updatePresenceUI();
      return;
    }

    if (data.type === "reads") {
      state.reads = Array.isArray(data.reads) ? data.reads : [];
      updateReadIndicators();
      return;
    }

    if (data.type === "settings") {
      state.settings = normalizeSettings(data.settings);
      if (Array.isArray(data.reads)) {
        state.reads = data.reads;
      }
      if (!state.settings.readReceipts) {
        state.reads = [];
        state.lastReadSentId = null;
      }
      updateReadIndicators();
      syncMenuSettings();
      if (state.settings.readReceipts) {
        scheduleRead(0);
      }
      return;
    }

    if (data.type === "closed") {
      handleRoomClosed();
      return;
    }

    if (data.type === "error") {
      showToast(typeof data.message === "string" && data.message ? data.message : "エラーが発生しました。", "error");
    }
  }

  /* ---------- menu ---------- */

  function openMenu() {
    if (state.menuOpen || !state.room) {
      return;
    }
    state.menuOpen = true;
    hideStampPopover();

    const layer = h("div", { className: "modal-layer" });
    const backdrop = h("div", { className: "modal-backdrop" });
    const panel = h("aside", {
      className: "menu-panel",
      attrs: { role: "dialog", "aria-modal": "true", "aria-label": "メニュー" }
    });
    backdrop.addEventListener("click", closeMenu);

    const closeButton = h("button", {
      className: "icon-btn",
      attrs: { type: "button", "aria-label": "メニューを閉じる" },
      text: "×"
    });
    closeButton.addEventListener("click", closeMenu);

    panel.appendChild(h(
      "div",
      { className: "menu-head" },
      h("h2", { text: "メニュー" }),
      closeButton
    ));

    const profile = h(
      "div",
      { className: "menu-profile" },
      h("span", { className: "avatar self", attrs: { "aria-hidden": "true" }, text: initials(state.selfName) }),
      h(
        "div",
        { className: "profile-main" },
        h("div", { className: "profile-name", attrs: { id: "menu-profile-name" }, text: state.selfName }),
        h(
          "div",
          { className: "profile-sub" },
          h("span", { className: "badge", text: `コード ${state.roomCode}` }),
          h("span", {
            className: state.isHost ? "badge badge-host" : "badge",
            text: state.isHost ? "ホスト" : "ゲスト"
          })
        )
      )
    );
    panel.appendChild(profile);

    const memberList = h("ul", { className: "member-list" });
    panel.appendChild(h(
      "section",
      { className: "menu-section" },
      h(
        "div",
        { className: "menu-section-title" },
        h("span", { text: "参加者" }),
        h("span", { attrs: { id: "menu-member-count" }, text: `${state.members.length}人` })
      ),
      memberList
    ));
    ui.menuMembers = memberList;

    const renameInput = h("input", {
      className: "text-input",
      attrs: {
        type: "text",
        maxlength: String(MAX_NAME_LENGTH),
        autocomplete: "nickname",
        "aria-label": "新しい表示名"
      },
      props: { value: state.selfName }
    });
    const renameButton = h("button", {
      className: "btn btn-primary",
      attrs: { type: "submit" },
      text: "変更"
    });
    const renameError = h("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
    const renameForm = h(
      "form",
      { className: "menu-form", attrs: { novalidate: true } },
      h("div", { className: "menu-form-row" }, renameInput, renameButton),
      renameError
    );
    renameForm.addEventListener("submit", (event) => {
      event.preventDefault();
      setFormError(renameError, "");
      const name = renameInput.value.trim();
      if (!name) {
        setFormError(renameError, "表示名を入力してください。");
        return;
      }
      if (Array.from(name).length > MAX_NAME_LENGTH) {
        setFormError(renameError, `表示名は${MAX_NAME_LENGTH}文字以内で入力してください。`);
        return;
      }
      if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
        setFormError(renameError, "接続が切れています。再接続後にもう一度お試しください。");
        return;
      }
      state.socket.send(JSON.stringify({ type: "rename", name }));
      state.selfName = name;
      if (state.self) {
        state.self.name = name;
      }
      sessionSet(`kc_name_${state.roomCode}`, name);
      renameInput.value = name;
      const profileName = document.getElementById("menu-profile-name");
      if (profileName) {
        profileName.textContent = name;
      }
      showToast("表示名を変更しました。", "success");
    });
    panel.appendChild(h(
      "section",
      { className: "menu-section" },
      h("div", { className: "menu-section-title" }, h("span", { text: "名前を変更" })),
      renameForm
    ));

    if (notificationsSupported()) {
      const notificationRow = h("div", { className: "menu-notification" });
      const notificationButton = h("button", {
        className: "menu-action",
        attrs: { type: "button" }
      });
      notificationButton.addEventListener("click", requestNotifications);
      notificationRow.appendChild(notificationButton);
      panel.appendChild(h(
        "section",
        { className: "menu-section" },
        h("div", { className: "menu-section-title" }, h("span", { text: "通知" })),
        notificationRow
      ));
    }

    if (state.isHost && !state.closed) {
      const qrAction = h("button", {
        className: "menu-action",
        attrs: { type: "button" }
      }, h(
        "span",
        { className: "action-main" },
        h("span", { className: "action-icon", attrs: { "aria-hidden": "true" }, text: "▦" }),
        h(
          "span",
          null,
          h("span", { text: "参加用QRコードを表示" }),
          h("span", { className: "action-sub", text: "読み取るだけで参加URLを共有できます。" })
        )
      ), h("span", { className: "chevron", attrs: { "aria-hidden": "true" }, text: "›" }));
      qrAction.addEventListener("click", () => {
        closeMenu();
        openQrDialog();
      });

      const readCheckbox = h("input", {
        attrs: { type: "checkbox", id: "menu-read-receipts" }
      });
      readCheckbox.checked = !!state.settings.readReceipts;
      readCheckbox.addEventListener("change", () => {
        updateReadReceiptsSetting(readCheckbox.checked, readCheckbox);
      });
      const readSwitch = h(
        "label",
        { className: "switch", attrs: { for: "menu-read-receipts" } },
        readCheckbox,
        h("span", { className: "switch-track", attrs: { "aria-hidden": "true" } })
      );

      const closeRoomButton = h("button", {
        className: "menu-action danger",
        attrs: { type: "button" }
      }, h(
        "span",
        { className: "action-main" },
        h("span", { className: "action-icon", attrs: { "aria-hidden": "true" }, text: "×" }),
        h(
          "span",
          null,
          h("span", { text: "ルームを閉じる" }),
          h("span", { className: "action-sub", text: "参加者全員がメッセージを送れなくなります。" })
        )
      ));

      panel.appendChild(h(
        "section",
        { className: "menu-section" },
        h("div", { className: "menu-section-title" }, h("span", { text: "ホスト設定" })),
        qrAction,
        h(
          "div",
          { className: "switch-row" },
          h(
            "span",
            { className: "switch-label" },
            h("span", { text: "既読を表示" }),
            h("span", { text: "オンにすると、自分の発言に既読人数を表示します。" })
          ),
          readSwitch
        ),
        h("hr", { className: "menu-divider" }),
        closeRoomButton
      ));
      closeRoomButton.addEventListener("click", closeRoomAsHost);
    }

    const homeButton = h("button", {
      className: "menu-action",
      attrs: { type: "button" }
    }, h(
      "span",
      { className: "action-main" },
      h("span", { className: "action-icon", attrs: { "aria-hidden": "true" }, text: "⌂" }),
      h("span", { text: "ホームへ戻る" })
    ));
    homeButton.addEventListener("click", () => {
      closeMenu();
      navigate(homePath());
    });
    panel.appendChild(h(
      "section",
      { className: "menu-section" },
      homeButton
    ));

    layer.appendChild(backdrop);
    layer.appendChild(panel);
    document.body.appendChild(layer);
    ui.menuLayer = layer;
    refreshMenuMembers();
    refreshMenuNotificationLabel();
    window.setTimeout(() => focusWithoutScroll(closeButton), 0);
  }

  function closeMenu() {
    if (ui.menuLayer) {
      ui.menuLayer.remove();
      ui.menuLayer = null;
    }
    ui.menuMembers = null;
    state.menuOpen = false;
  }

  function refreshMenuMembers() {
    if (!ui.menuMembers) {
      return;
    }
    clearNode(ui.menuMembers);
    if (!state.members.length) {
      ui.menuMembers.appendChild(h("li", {
        className: "member-item",
        text: "接続中…"
      }));
    } else {
      state.members.forEach((member) => {
        const isSelf = String(member.clientId) === String(state.clientId);
        ui.menuMembers.appendChild(h(
          "li",
          { className: "member-item" },
          h("span", {
            className: isSelf ? "avatar self" : "avatar",
            attrs: { "aria-hidden": "true" },
            text: initials(member.name || "ゲスト")
          }),
          h(
            "span",
            { className: "member-main" },
            h("span", { className: "member-name", text: member.name || "ゲスト" }),
            isSelf ? h("span", { className: "member-you", text: "あなた" }) : null
          ),
          h("span", {
            className: member.role === "host" ? "role-badge host" : "role-badge",
            text: member.role === "host" ? "ホスト" : "ゲスト"
          })
        ));
      });
    }
    const count = document.getElementById("menu-member-count");
    if (count) {
      count.textContent = `${state.members.length}人`;
    }
  }

  function refreshMenuNotificationLabel() {
    const button = document.querySelector(".menu-notification .menu-action");
    if (!button) {
      return;
    }
    clearNode(button);
    let title = "通知を有効にする";
    let subtitle = "ブラウザを表示していないときに新着をお知らせします。";
    let icon = "🔔";
    if (Notification.permission === "granted") {
      title = "通知は有効です";
      subtitle = "新着メッセージを端末に通知します。";
      icon = "🔕";
    } else if (Notification.permission === "denied") {
      title = "通知がブロックされています";
      subtitle = "ブラウザの設定から通知を許可してください。";
      icon = "🔇";
    }
    button.appendChild(h(
      "span",
      { className: "action-main" },
      h("span", { className: "action-icon", attrs: { "aria-hidden": "true" }, text: icon }),
      h(
        "span",
        null,
        h("span", { text: title }),
        h("span", { className: "action-sub", text: subtitle })
      )
    ));
    button.appendChild(h("span", { className: "chevron", attrs: { "aria-hidden": "true" }, text: "›" }));
  }

  function syncMenuSettings() {
    const checkbox = document.getElementById("menu-read-receipts");
    if (checkbox) {
      checkbox.checked = !!state.settings.readReceipts;
    }
    refreshMenuNotificationLabel();
  }

  async function updateReadReceiptsSetting(enabled, checkbox) {
    if (!state.isHost || state.closed) {
      return;
    }
    if (checkbox) {
      checkbox.disabled = true;
    }
    try {
      const data = await apiRequest(`/api/rooms/${encodeURIComponent(state.roomCode)}/settings`, {
        method: "POST",
        body: {
          hostId: getHostId(),
          settings: { readReceipts: !!enabled }
        }
      });
      state.settings = normalizeSettings(data && data.settings ? data.settings : { readReceipts: enabled });
      if (!enabled) {
        state.lastReadSentId = null;
      }
      updateReadIndicators();
      syncMenuSettings();
      if (state.settings.readReceipts) {
        scheduleRead(0);
      }
      showToast(
        state.settings.readReceipts ? "既読表示をオンにしました。" : "既読表示をオフにしました。",
        "success"
      );
    } catch (error) {
      if (checkbox) {
        checkbox.checked = !enabled;
      }
      showToast(error && error.message ? error.message : "設定を変更できませんでした。", "error");
    } finally {
      if (checkbox) {
        checkbox.disabled = false;
      }
    }
  }

  async function closeRoomAsHost() {
    if (!state.isHost || state.closed) {
      return;
    }
    const confirmed = window.confirm("ルームを閉じますか？\n参加者全員がメッセージを送信できなくなります。この操作は取り消せません。");
    if (!confirmed) {
      return;
    }
    try {
      await apiRequest(`/api/rooms/${encodeURIComponent(state.roomCode)}/close`, {
        method: "POST",
        body: { hostId: getHostId() }
      });
      handleRoomClosed();
      showToast("ルームを閉じました。", "success");
    } catch (error) {
      showToast(error && error.message ? error.message : "ルームを閉じられませんでした。", "error");
    }
  }

  /* ---------- QR code ---------- */

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_error) {
      /* fall through to the legacy path */
    }

    try {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      input.style.pointerEvents = "none";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (copied) {
        return true;
      }
    } catch (_error) {
      /* ignore */
    }
    return false;
  }

  function openQrDialog() {
    if (!state.room) {
      return;
    }
    closeQrDialog();
    const joinUrl = `${window.location.origin}/r/${encodeURIComponent(state.roomCode || state.room.code)}`;
    const layer = h("div", { className: "modal-layer qr-layer" });
    const backdrop = h("div", { className: "modal-backdrop" });
    backdrop.addEventListener("click", closeQrDialog);

    const closeButton = h("button", {
      className: "icon-btn qr-close",
      attrs: { type: "button", "aria-label": "QRコードを閉じる" },
      text: "×"
    });
    closeButton.addEventListener("click", closeQrDialog);

    const qrBox = h("div", { className: "qr-box" });
    try {
      if (typeof window.qrcode !== "function") {
        throw new Error("QR library unavailable");
      }
      const qr = window.qrcode(0, "M");
      qr.addData(joinUrl);
      qr.make();
      const roomName = state.room.name || APP_NAME;
      const svg = qr.createSvgTag(4, 4, "参加QRコード", roomName);
      if (typeof svg !== "string" || svg.indexOf("<svg") !== 0) {
        throw new Error("Invalid SVG");
      }
      /* Only the library-generated SVG string is inserted here. User input is never interpolated. */
      qrBox.innerHTML = svg;
      if (!qrBox.querySelector("svg")) {
        throw new Error("SVG element missing");
      }
    } catch (_error) {
      clearNode(qrBox);
      qrBox.appendChild(h("div", {
        className: "qr-fallback",
        text: "QRコードを表示できませんでした。下のURLを共有してください。"
      }));
    }

    const urlText = h("div", { className: "qr-url", text: joinUrl });
    const copyButton = h("button", {
      className: "btn btn-primary",
      attrs: { type: "button" },
      text: "URLをコピー"
    });
    copyButton.addEventListener("click", async () => {
      const copied = await copyText(joinUrl);
      if (copied) {
        showToast("参加URLをコピーしました。", "success");
      } else {
        showToast("コピーできませんでした。URLを長押ししてコピーしてください。", "error");
      }
    });
    const closeButton2 = h("button", {
      className: "btn btn-ghost",
      attrs: { type: "button" },
      text: "閉じる"
    });
    closeButton2.addEventListener("click", closeQrDialog);

    const card = h(
      "div",
      { className: "qr-card", attrs: { role: "dialog", "aria-modal": "true", "aria-label": "参加用QRコード" } },
      closeButton,
      h("h2", { text: "参加用QRコード" }),
      h("p", { text: "スマートフォンのカメラで読み取ると、このルームに参加できます。" }),
      qrBox,
      urlText,
      h("div", { className: "qr-actions" }, copyButton, closeButton2)
    );

    layer.appendChild(backdrop);
    layer.appendChild(card);
    document.body.appendChild(layer);
    ui.qrLayer = layer;
    window.setTimeout(() => focusWithoutScroll(closeButton), 0);
  }

  function closeQrDialog() {
    if (ui.qrLayer) {
      ui.qrLayer.remove();
      ui.qrLayer = null;
    }
  }

  let scanFrame = 0;
  let scanStream = null;

  function isMobileGuest() {
    return window.matchMedia("(pointer: coarse)").matches && window.matchMedia("(max-width: 700px)").matches;
  }

  function closeQrScanner() {
    if (scanFrame) { window.cancelAnimationFrame(scanFrame); scanFrame = 0; }
    if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop(); }); scanStream = null; }
    if (ui.scanLayer) { ui.scanLayer.remove(); ui.scanLayer = null; }
  }

  function handleScannedValue(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    const codePattern = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;
    try {
      const url = new URL(value);
      if (url.origin === window.location.origin) {
        const match = /^\/r\/([^/]+)\/?$/.exec(url.pathname);
        if (match) {
          const code = decodeURIComponent(match[1]);
          if (codePattern.test(code)) {
            closeQrScanner();
            navigate("/r/" + encodeURIComponent(code));
            return true;
          }
        }
      }
    } catch (_error) { /* raw code or foreign URL */ }
    if (codePattern.test(value)) {
      closeQrScanner();
      navigate("/r/" + encodeURIComponent(value));
      return true;
    }
    return false;
  }

  async function openQrScanner() {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast("カメラを使うには HTTPS（または localhost）が必要です。");
      return;
    }
    if (typeof window.jsQR !== "function") {
      showToast("QR読み取りライブラリを読み込めませんでした。");
      return;
    }
    closeQrScanner();

    const layer = h("div", { className: "modal-layer scan-layer" });
    const backdrop = h("div", { className: "modal-backdrop" });
    backdrop.addEventListener("click", closeQrScanner);
    const video = h("video", { className: "scan-video", attrs: { autoplay: true, muted: true, playsinline: true } });
    const canvas = h("canvas", { className: "scan-canvas" });
    const error = h("p", { className: "scan-error", attrs: { role: "status" }, props: { hidden: true } });
    const closeButton = h("button", { className: "icon-btn scan-close", attrs: { type: "button", "aria-label": "QRスキャナを閉じる" }, text: "×" });
    closeButton.addEventListener("click", closeQrScanner);
    const manualButton = h("button", { className: "btn btn-ghost", attrs: { type: "button" }, text: "コードを手入力" });
    manualButton.addEventListener("click", function () {
      closeQrScanner();
      const input = document.getElementById("home-room-code");
      if (input) focusWithoutScroll(input);
    });
    const cancelButton = h("button", { className: "btn btn-ghost", attrs: { type: "button" }, text: "閉じる" });
    cancelButton.addEventListener("click", closeQrScanner);
    const card = h(
      "div",
      { className: "scan-card", attrs: { role: "dialog", "aria-modal": "true", "aria-label": "QRコードを読み取る" } },
      closeButton,
      h("h2", { text: "QRコードを読み取る" }),
      h("p", { text: "参加用QRコードをカメラに合わせてください。" }),
      video,
      canvas,
      error,
      h("div", { className: "scan-actions" }, manualButton, cancelButton)
    );
    layer.appendChild(backdrop);
    layer.appendChild(card);
    document.body.appendChild(layer);
    ui.scanLayer = layer;
    focusWithoutScroll(closeButton);

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    } catch (_error) {
      error.textContent = "カメラを起動できませんでした。許可設定を確認してください。";
      error.hidden = false;
      return;
    }
    if (!ui.scanLayer) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    scanStream = stream;
    video.srcObject = stream;
    try { await video.play(); } catch (_error) { /* ignore play errors */ }

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    function tick() {
      if (!ui.scanLayer) return;
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight && ctx) {
        const width = Math.min(video.videoWidth, 640);
        const height = Math.round(video.videoHeight * width / video.videoWidth);
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(video, 0, 0, width, height);
        const image = ctx.getImageData(0, 0, width, height);
        const found = window.jsQR(image.data, width, height, { inversionAttempts: "dontInvert" });
        if (found && handleScannedValue(found.data)) return;
        error.textContent = "QRコードが見つかりません。カメラに合わせてください。";
        error.hidden = false;
      }
      scanFrame = window.requestAnimationFrame(tick);
    }
    scanFrame = window.requestAnimationFrame(tick);
  }

  /* ---------- toasts ---------- */

  function showToast(message, tone) {
    if (!message) {
      return;
    }
    if (!ui.toastStack) {
      ui.toastStack = h("div", { className: "toast-stack", attrs: { role: "status", "aria-live": "polite" } });
      document.body.appendChild(ui.toastStack);
    }
    const toast = h("div", {
      className: tone === "error" ? "toast error" : tone === "success" ? "toast success" : "toast",
      text: message
    });
    ui.toastStack.appendChild(toast);
    while (ui.toastStack.children.length > 3) {
      ui.toastStack.firstElementChild.remove();
    }
    window.setTimeout(() => {
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 200);
    }, 3200);
  }

  /* ---------- global events ---------- */

  let appHeightFrame = 0;
  let lastViewportHeight = 0;
  let scrollAfterKeyboard = false;

  function updateAppHeight() {
    const viewport = window.visualViewport;
    const height = viewport && viewport.height ? viewport.height : window.innerHeight;
    const root = document.documentElement;
    if (height > 0) {
      root.style.setProperty("--app-height", `${Math.round(height)}px`);
      root.style.setProperty("--vvh", `${Math.round(height)}px`);
    }
    root.style.setProperty("--vv-top", `${Math.round(viewport ? viewport.offsetTop : 0)}px`);
    root.style.setProperty("--vv-left", `${Math.round(viewport ? viewport.offsetLeft : 0)}px`);
    if (lastViewportHeight && height < lastViewportHeight - 40) {
      scrollAfterKeyboard = true;
    }
    lastViewportHeight = height;
  }

  function scheduleAppHeight() {
    if (appHeightFrame) return;
    appHeightFrame = window.requestAnimationFrame(function () {
      appHeightFrame = 0;
      updateAppHeight();
      if (scrollAfterKeyboard) {
        scrollAfterKeyboard = false;
        window.requestAnimationFrame(function () {
          if (ui.messages) {
            ui.messages.scrollTop = ui.messages.scrollHeight;
          }
        });
      }
    });
  }

  function bindAppHeight() {
    updateAppHeight();
    window.addEventListener("resize", scheduleAppHeight);
    window.addEventListener("orientationchange", scheduleAppHeight);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", scheduleAppHeight);
      window.visualViewport.addEventListener("scroll", scheduleAppHeight);
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") {
      clearUnread();
      scheduleRead(0);
    } else {
      hideStampPopover();
    }
  }

  function handleWindowFocus() {
    clearUnread();
    scheduleRead(0);
  }

  function handleOnline() {
    if (!state.joined || state.closed || state.wsStatus === "open") {
      return;
    }
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (!state.socket) {
      connectSocket();
    }
  }

  function handleGlobalKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }
    if (ui.lightbox) {
      closeLightbox();
      return;
    }
    if (ui.scanLayer) {
      closeQrScanner();
      return;
    }
    if (ui.qrLayer) {
      closeQrDialog();
      return;
    }
    if (ui.menuLayer) {
      closeMenu();
      return;
    }
    if (ui.stampPopover && !ui.stampPopover.hidden) {
      hideStampPopover();
    }
  }

  function handleDocumentPointerDown(event) {
    if (state.joined && state.settings.readReceipts && document.visibilityState === "visible") {
      scheduleRead(READ_DEBOUNCE_MS);
    }
    if (!ui.stampPopover || ui.stampPopover.hidden) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (ui.stampPopover.contains(target)) {
      return;
    }
    if (ui.stampButton && ui.stampButton.contains(target)) {
      return;
    }
    hideStampPopover();
  }

  function init() {
    ui.app = document.getElementById("app");
    if (!ui.app) {
      return;
    }

    bindAppHeight();
    registerServiceWorker();
    window.addEventListener("popstate", applyRoute);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("online", handleOnline);
    document.addEventListener("keydown", handleGlobalKeyDown);
    document.addEventListener("pointerdown", handleDocumentPointerDown, { passive: true });

    applyRoute();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
