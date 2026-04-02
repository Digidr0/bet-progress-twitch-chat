import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import "./TwitchSocketPanel.css";

const CLIENT_ID_KEY = "twitch:client-id";
const ACCESS_TOKEN_KEY = "twitch:access-token";
const CHANNEL_KEY = "twitch:channel";
const OAUTH_STATE_KEY = "twitch:oauth-state";
const MAX_LOGS = 150;

const EVENTSUB_WS = "wss://eventsub.wss.twitch.tv/ws";
const EVENTSUB_API = "https://api.twitch.tv/helix/eventsub/subscriptions";
const OAUTH_AUTHORIZE = "https://id.twitch.tv/oauth2/authorize";
const OAUTH_VALIDATE = "https://id.twitch.tv/oauth2/validate";

const REQUIRED_SCOPES = [
  "channel:read:predictions",
  "channel:read:redemptions",
];

type SocketStatus = "disconnected" | "connecting" | "connected";
type AuthStatus = "empty" | "checking" | "valid" | "invalid";

const normalizeChannel = (value: string) =>
  value.trim().replace(/^#/, "").toLowerCase();

const formatLogTime = () =>
  new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

const parseHashParams = (hash: string) => {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(trimmed);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

const buildAuthUrl = (clientId: string, redirectUri: string, state: string) => {
  const params = new URLSearchParams({
    response_type: "token",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: REQUIRED_SCOPES.join(" "),
    state,
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
};

const parseEventSubPayload = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export default function TwitchSocketPanel() {
  const [clientId, setClientId] = createSignal("");
  const [accessToken, setAccessToken] = createSignal("");
  const [channelName, setChannelName] = createSignal("");
  const [authStatus, setAuthStatus] = createSignal<AuthStatus>("empty");
  const [authUserLogin, setAuthUserLogin] = createSignal("");
  const [authUserId, setAuthUserId] = createSignal("");
  const [authScopes, setAuthScopes] = createSignal<string[]>([]);
  const [authExpiresIn, setAuthExpiresIn] = createSignal<number | null>(null);

  const [socketStatus, setSocketStatus] =
    createSignal<SocketStatus>("disconnected");
  const [sessionId, setSessionId] = createSignal("");
  const [socketResponses, setSocketResponses] = createSignal<string[]>([]);
  const [socketErrors, setSocketErrors] = createSignal<string[]>([]);
  const [socketJson, setSocketJson] = createSignal<unknown[]>([]);
  const [predictionJson, setPredictionJson] = createSignal<unknown[]>([]);
  const [socketUrl, setSocketUrl] = createSignal(EVENTSUB_WS);

  let eventSocket: WebSocket | null = null;

  const pushLog = (
    setter: (value: (prev: string[]) => string[]) => void,
    message: string,
  ) => {
    setter((prev) => {
      const next = [...prev, `${formatLogTime()} ${message}`];
      if (next.length > MAX_LOGS) {
        next.splice(0, next.length - MAX_LOGS);
      }
      return next;
    });
  };

  const pushJsonLog = (payload: unknown) => {
    setSocketJson((prev) => {
      const next = [...prev, payload];
      if (next.length > MAX_LOGS) {
        next.splice(0, next.length - MAX_LOGS);
      }
      return next;
    });
  };

  const pushPredictionLog = (payload: unknown) => {
    setPredictionJson((prev) => {
      const next = [...prev, payload];
      if (next.length > MAX_LOGS) {
        next.splice(0, next.length - MAX_LOGS);
      }
      return next;
    });
  };

  const clearLogs = () => {
    setSocketResponses([]);
    setSocketErrors([]);
    setSocketJson([]);
    setPredictionJson([]);
  };

  const storeValue = (key: string, value: string) => {
    if (value.trim()) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  };

  const disconnectSocket = () => {
    if (!eventSocket) {
      setSocketStatus("disconnected");
      setSessionId("");
      return;
    }
    eventSocket.close();
    eventSocket = null;
    setSocketStatus("disconnected");
    setSessionId("");
    pushLog(setSocketResponses, "-> Соединение закрыто пользователем.");
  };

  const handleEventSubMessage = (raw: string) => {
    const parsed = parseEventSubPayload(raw);
    if (!parsed || typeof parsed !== "object") {
      pushLog(setSocketErrors, "Не удалось распарсить JSON сообщения.");
      return;
    }

    const metadata = (parsed as { metadata?: { message_type?: string } })
      .metadata;
    const messageType = metadata?.message_type ?? "unknown";

    pushJsonLog(parsed);

    if (messageType === "session_welcome") {
      const payload = (parsed as { payload?: { session?: { id?: string } } })
        .payload;
      const id = payload?.session?.id ?? "";
      setSessionId(id);
      setSocketStatus("connected");
      pushLog(setSocketResponses, `EventSub session: ${id || "—"}`);
      return;
    }

    if (messageType === "session_keepalive") {
      pushLog(setSocketResponses, "KEEPALIVE");
      return;
    }

    if (messageType === "notification") {
      const subscription = (
        parsed as {
          payload?: { subscription?: { type?: string } };
        }
      ).payload?.subscription;
      const eventType = subscription?.type ?? "unknown";
      if (eventType.startsWith("channel.prediction.")) {
        pushPredictionLog(parsed);
      }
      pushLog(setSocketResponses, `EVENT: ${eventType}`);
      return;
    }

    if (messageType === "session_reconnect") {
      const payload = (
        parsed as {
          payload?: { session?: { reconnect_url?: string } };
        }
      ).payload;
      const reconnectUrl = payload?.session?.reconnect_url;
      if (reconnectUrl) {
        pushLog(setSocketResponses, "Получен reconnect URL, переподключаемся.");
        if (eventSocket) {
          eventSocket.close();
          eventSocket = null;
        }
        connectSocket(reconnectUrl);
      }
      return;
    }

    pushLog(setSocketResponses, `Сообщение: ${messageType}`);
  };

  const connectSocket = (url = EVENTSUB_WS) => {
    if (
      eventSocket &&
      (eventSocket.readyState === WebSocket.OPEN ||
        eventSocket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    setSocketUrl(url);
    setSocketStatus("connecting");
    setSessionId("");

    const socket = new WebSocket(url);
    eventSocket = socket;

    socket.addEventListener("open", () => {
      if (eventSocket !== socket) return;
      pushLog(setSocketResponses, "-> EventSub соединение открыто.");
    });

    socket.addEventListener("message", (event) => {
      if (eventSocket !== socket) return;
      const raw =
        typeof event.data === "string" ? event.data : String(event.data);
      pushLog(setSocketResponses, `<- ${raw}`);
      handleEventSubMessage(raw);
    });

    socket.addEventListener("error", (event) => {
      if (eventSocket !== socket) return;
      pushLog(setSocketErrors, `Ошибка сокета: ${event.type}`);
    });

    socket.addEventListener("close", (event) => {
      if (eventSocket !== socket) return;
      pushLog(setSocketResponses, `EventSub закрыт (code: ${event.code}).`);
      setSocketStatus("disconnected");
      setSessionId("");
    });
  };

  const validateToken = async () => {
    const token = accessToken().trim();
    if (!token) {
      setAuthStatus("empty");
      setAuthUserLogin("");
      setAuthUserId("");
      setAuthScopes([]);
      setAuthExpiresIn(null);
      return;
    }

    setAuthStatus("checking");
    try {
      const response = await fetch(OAUTH_VALIDATE, {
        headers: {
          Authorization: `OAuth ${token}`,
        },
      });
      const data = await response.json();
      pushJsonLog({ source: "validate", data });
      if (!response.ok) {
        throw new Error(data?.message ?? `HTTP ${response.status}`);
      }

      setAuthStatus("valid");
      setAuthUserLogin(data.login ?? "");
      setAuthUserId(data.user_id ?? "");
      setAuthScopes(Array.isArray(data.scopes) ? data.scopes : []);
      setAuthExpiresIn(
        typeof data.expires_in === "number" ? data.expires_in : null,
      );

      if (!channelName() && typeof data.login === "string") {
        setChannelName(data.login);
        storeValue(CHANNEL_KEY, data.login);
      }
    } catch (error) {
      setAuthStatus("invalid");
      pushLog(
        setSocketErrors,
        `Ошибка проверки токена: ${error instanceof Error ? error.message : "?"}`,
      );
    }
  };

  const startOAuth = () => {
    const id = clientId().trim();
    if (!id) {
      pushLog(setSocketErrors, "Нужен Client ID для OAuth.");
      return;
    }
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    const state =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    localStorage.setItem(OAUTH_STATE_KEY, state);
    window.location.assign(buildAuthUrl(id, redirectUri, state));
  };

  const clearAuth = () => {
    setAccessToken("");
    setAuthStatus("empty");
    setAuthUserLogin("");
    setAuthUserId("");
    setAuthScopes([]);
    setAuthExpiresIn(null);
    storeValue(ACCESS_TOKEN_KEY, "");
  };

  const resolveBroadcasterId = async () => {
    const channel = normalizeChannel(channelName());
    if (!channel) {
      throw new Error("Нужно указать имя канала.");
    }

    const login = authUserLogin().trim().toLowerCase();
    if (login && login === channel && authUserId()) {
      return authUserId();
    }

    const id = clientId().trim();
    const token = accessToken().trim();
    if (!id || !token) {
      throw new Error("Нужны Client ID и access token.");
    }

    const response = await fetch(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(channel)}`,
      {
        headers: {
          "Client-ID": id,
          Authorization: `Bearer ${token}`,
        },
      },
    );
    const data = await response.json();
    pushJsonLog({ source: "resolve_user", data });
    if (!response.ok) {
      throw new Error(data?.message ?? `HTTP ${response.status}`);
    }
    const user = Array.isArray(data.data) ? data.data[0] : null;
    if (!user?.id) {
      throw new Error("Канал не найден.");
    }
    return user.id as string;
  };

  const createSubscription = async (
    type: string,
    version: string,
    broadcasterId: string,
  ) => {
    const id = clientId().trim();
    const token = accessToken().trim();
    const session = sessionId().trim();

    if (!id || !token) {
      throw new Error("Нужны Client ID и access token.");
    }
    if (!session) {
      throw new Error("Нет session_id EventSub.");
    }

    const payload = {
      type,
      version,
      condition: {
        broadcaster_user_id: broadcasterId,
      },
      transport: {
        method: "websocket",
        session_id: session,
      },
    };

    const response = await fetch(EVENTSUB_API, {
      method: "POST",
      headers: {
        "Client-ID": id,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    pushJsonLog({ source: "subscription", type, data });
    if (!response.ok) {
      throw new Error(data?.message ?? `HTTP ${response.status}`);
    }
  };

  const subscribeAll = async () => {
    try {
      const broadcasterId = await resolveBroadcasterId();
      const subscriptionTypes = [
        { type: "channel.prediction.begin", version: "1" },
        { type: "channel.prediction.progress", version: "1" },
        { type: "channel.prediction.lock", version: "1" },
        { type: "channel.prediction.end", version: "1" },
        {
          type: "channel.channel_points_custom_reward_redemption.add",
          version: "1",
        },
      ];

      for (const item of subscriptionTypes) {
        await createSubscription(item.type, item.version, broadcasterId);
        pushLog(setSocketResponses, `Подписка создана: ${item.type}`);
      }
    } catch (error) {
      pushLog(
        setSocketErrors,
        `Ошибка подписки: ${error instanceof Error ? error.message : "?"}`,
      );
    }
  };

  onMount(() => {
    const storedClientId = localStorage.getItem(CLIENT_ID_KEY);
    const storedToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    const storedChannel = localStorage.getItem(CHANNEL_KEY);

    if (storedClientId) setClientId(storedClientId);
    if (storedToken) setAccessToken(storedToken);
    if (storedChannel) setChannelName(storedChannel);

    const params = parseHashParams(window.location.hash);
    if (params.access_token) {
      const expectedState = localStorage.getItem(OAUTH_STATE_KEY);
      if (expectedState && params.state && params.state !== expectedState) {
        pushLog(setSocketErrors, "OAuth state не совпал, токен не сохранен.");
      } else {
        setAccessToken(params.access_token);
        storeValue(ACCESS_TOKEN_KEY, params.access_token);
        if (params.scope) {
          setAuthScopes(params.scope.split(" ").filter(Boolean));
        }
        pushLog(setSocketResponses, "OAuth токен получен.");
      }

      localStorage.removeItem(OAUTH_STATE_KEY);
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname + window.location.search,
      );
    }

    if (storedToken || params.access_token) {
      void validateToken();
    }
  });

  onCleanup(() => {
    if (eventSocket) {
      eventSocket.close();
      eventSocket = null;
    }
  });

  const socketStatusText = createMemo(() => {
    const status = socketStatus();
    if (status === "connected") return "Подключено";
    if (status === "connecting") return "Подключение...";
    return "Отключено";
  });

  const authStatusText = createMemo(() => {
    const status = authStatus();
    if (status === "valid") return "Токен валиден";
    if (status === "checking") return "Проверяем токен...";
    if (status === "invalid") return "Токен недействителен";
    return "Токен не задан";
  });

  const socketResponsesText = createMemo(() => {
    const logs = socketResponses();
    if (logs.length === 0) return "Ждем ответов сокета.";
    return logs.join("\n");
  });

  const socketErrorsText = createMemo(() => {
    const logs = socketErrors();
    if (logs.length === 0) return "Ошибок пока нет.";
    return logs.join("\n");
  });

  const socketJsonText = createMemo(() => {
    const logs = socketJson();
    if (logs.length === 0) return "Пока нет данных JSON.";
    return logs.map((entry) => JSON.stringify(entry, null, 2)).join("\n\n");
  });

  const predictionJsonText = createMemo(() => {
    const logs = predictionJson();
    if (logs.length === 0) return "Пока нет данных по прогнозам.";
    return logs.map((entry) => JSON.stringify(entry, null, 2)).join("\n\n");
  });

  const scopeBadges = createMemo(() => {
    const scopes = authScopes();
    if (scopes.length === 0) return "—";
    return scopes.join(" · ");
  });

  const requiredScopesMissing = createMemo(() => {
    const scopes = new Set(authScopes());
    return REQUIRED_SCOPES.filter((scope) => !scopes.has(scope));
  });

  return (
    <section class="panel socket-panel">
      <h2>EventSub: прогнозы и баллы</h2>

      <div class="auth-grid">
        <label class="field">
          <span>Client ID</span>
          <input
            type="text"
            value={clientId()}
            placeholder="Twitch Client ID"
            onInput={(event) => {
              const value = event.currentTarget.value;
              setClientId(value);
              storeValue(CLIENT_ID_KEY, value);
            }}
          />
        </label>
        <label class="field">
          <span>Access Token</span>
          <input
            type="text"
            value={accessToken()}
            placeholder="oauth token"
            onInput={(event) => {
              const value = event.currentTarget.value;
              setAccessToken(value);
              storeValue(ACCESS_TOKEN_KEY, value);
            }}
          />
        </label>
      </div>

      <div class="socket-actions">
        <button type="button" class="action primary" onClick={startOAuth}>
          Войти через Twitch
        </button>
        <button type="button" class="action" onClick={validateToken}>
          Проверить токен
        </button>
        <button type="button" class="action ghost" onClick={clearAuth}>
          Очистить токен
        </button>
        <div class={`auth-status ${authStatus()}`}>
          <span class="status-dot" />
          <span>{authStatusText()}</span>
          <span class="status-meta">
            {authUserLogin() ? authUserLogin() : "user: —"}
            {authExpiresIn() !== null ? ` · ${authExpiresIn()}s` : ""}
          </span>
        </div>
      </div>

      <div class="auth-meta">
        <div>
          <span class="meta-label">Scopes:</span> {scopeBadges()}
        </div>
        {requiredScopesMissing().length > 0 ? (
          <div class="meta-warning">
            Не хватает: {requiredScopesMissing().join(", ")}
          </div>
        ) : (
          <div class="meta-ok">Все нужные scopes получены.</div>
        )}
      </div>

      <label class="field">
        <span>Имя канала</span>
        <input
          type="text"
          value={channelName()}
          placeholder="Например, shroud"
          onInput={(event) => {
            const value = event.currentTarget.value;
            setChannelName(value);
            storeValue(CHANNEL_KEY, value);
          }}
        />
      </label>

      <div class="socket-actions">
        <button
          type="button"
          class="action primary"
          onClick={() => connectSocket()}
        >
          Подключить EventSub
        </button>
        <button type="button" class="action" onClick={disconnectSocket}>
          Отключить
        </button>
        <button type="button" class="action" onClick={subscribeAll}>
          Подписаться на события
        </button>
        <button type="button" class="action ghost" onClick={clearLogs}>
          Очистить логи
        </button>
        <div class={`socket-status ${socketStatus()}`}>
          <span class="status-dot" />
          <span>{socketStatusText()}</span>
          <span class="status-meta">
            {sessionId() ? `session ${sessionId()}` : "session: —"}
          </span>
        </div>
      </div>

      <div class="auth-meta">
        <div>
          <span class="meta-label">EventSub WS:</span> {socketUrl()}
        </div>
      </div>

      <div class="socket-logs two-columns">
        <div class="socket-log-group">
          <div class="socket-log">
            <h3>Ответы</h3>
            <pre>{socketResponsesText()}</pre>
          </div>
          <div class="socket-log">
            <h3>Ошибки</h3>
            <pre>{socketErrorsText()}</pre>
          </div>
        </div>
        <div class="socket-log-group">
          <div class="socket-log">
            <h3>JSON</h3>
            <pre>{socketJsonText()}</pre>
          </div>
          <div class="socket-log">
            <h3>Прогнозы (JSON)</h3>
            <pre>{predictionJsonText()}</pre>
          </div>
        </div>
      </div>
    </section>
  );
}
