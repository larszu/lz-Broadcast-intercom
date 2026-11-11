import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreState, EventItem, ServerMessage } from "@broadcast/shared";

export type AudioChunkPayload = Extract<ServerMessage, { type: "audio_chunk" }>["payload"];

const emptyState: CoreState = {
  activeConfig: { name: "—", updatedAt: 0 },
  users: {},
  devices: {},
  antennas: {},
  channels: {},
  groups: {},
  temporaryChannels: [],
  profiles: {},
  sessions: {},
  matrixRoutes: [],
  pluginBridge: {
    enabled: false,
    protocol: "ws",
    host: "ws://127.0.0.1:39000",
    pluginPaths: [],
    bypass: true,
  },
  events: [],
};

export function useIntercomStore() {
  const [state, setState] = useState<CoreState>(emptyState);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const audioChunkHandlerRef = useRef<((p: AudioChunkPayload) => void) | null>(null);

  const sendWs = useCallback((message: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  const setAudioChunkHandler = useCallback(
    (fn: ((p: AudioChunkPayload) => void) | null) => {
      audioChunkHandlerRef.current = fn;
    },
    [],
  );

  async function api<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await res.json()) as T;
  }

  useEffect(() => {
    // Reconnect mit Backoff (#40): 1 s, 2 s, 4 s … hoechstens 30 s statt
    // Dauerfeuer alle 3 s, solange der Kern fehlt. Beim Abbau der Komponente
    // keinen neuen Versuch mehr planen.
    let attempt = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        const delay = Math.min(30000, 1000 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        if (msg.type === "state") {
          setState(msg.payload as CoreState);
        }
        if (msg.type === "event") {
          const event = msg.payload as EventItem;
          setEvents((prev) => [event, ...prev].slice(0, 300));
        }
        if (msg.type === "audio_chunk") {
          audioChunkHandlerRef.current?.(msg.payload);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  return { state, setState, events, connected, sendWs, api, setAudioChunkHandler };
}
