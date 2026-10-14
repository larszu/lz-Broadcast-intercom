import { useEffect, useState } from "react";
import type { CaptionFeed, CoreState } from "@broadcast/shared";
import { useLang } from "../i18n";

interface Props {
  state: CoreState;
  api: <T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown) => Promise<T>;
}

type Result = { ok: boolean; error?: string };

const FALLBACK: CaptionFeed = { enabled: false, host: "127.0.0.1", port: 4210, address: "/lzvm/caption", channelIds: [], includeSpeaker: false };

export function CaptionFeedView({ state, api }: Props) {
  const { t } = useLang();
  const saved = state.captionFeed ?? FALLBACK;
  const channels = Object.values(state.channels);
  const [host, setHost] = useState(saved.host);
  const [port, setPort] = useState(String(saved.port));
  const [address, setAddress] = useState(saved.address);
  const [layer, setLayer] = useState(saved.layer === undefined ? "" : String(saved.layer));
  const [message, setMessage] = useState("");

  // Text fields follow the server only when the saved target changes, so a
  // state broadcast does not overwrite what is being typed.
  useEffect(() => {
    setHost(saved.host);
    setPort(String(saved.port));
    setAddress(saved.address);
    setLayer(saved.layer === undefined ? "" : String(saved.layer));
  }, [saved.host, saved.port, saved.address, saved.layer]);

  async function save(patch: Partial<CaptionFeed> & { layer?: number | string }) {
    const r = await api<Result>("PATCH", "/api/automation/captions", {
      ...saved,
      host,
      port: Number(port),
      address,
      layer: layer.trim() === "" ? "" : Number(layer),
      ...patch,
    });
    setMessage(r.ok ? t.captionsSaved : `${t.captionsFailed}: ${r.error ?? ""}`);
  }

  async function test() {
    const r = await api<Result>("POST", "/api/automation/captions/test");
    setMessage(r.ok ? t.captionsTestSent : `${t.captionsFailed}: ${r.error ?? ""}`);
  }

  function toggleChannel(id: string, on: boolean) {
    const next = on ? [...saved.channelIds, id] : saved.channelIds.filter((c) => c !== id);
    void save({ channelIds: next });
  }

  return (
    <div className="viewPanel">
      <h2>{t.captionsTitle}</h2>
      <p className="dim">{t.captionsIntro}</p>

      <label className="checkRow">
        <input type="checkbox" checked={saved.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        <strong>{t.captionsEnabled}</strong>
      </label>

      <div className="ruleForm">
        <label>
          <span>{t.ruleHost}</span>
          <input value={host} onChange={(e) => setHost(e.target.value)} />
        </label>
        <label>
          <span>{t.rulePort}</span>
          <input value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} />
        </label>
        <label>
          <span>{t.ruleAddress}</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label>
          <span>{t.captionsLayer}</span>
          <input value={layer} inputMode="numeric" onChange={(e) => setLayer(e.target.value)} />
        </label>
        <button onClick={() => void save({})}>{t.captionsSave}</button>
        <button className="btnSmall" onClick={() => void test()}>{t.ruleTest}</button>
      </div>

      <label className="checkRow">
        <input type="checkbox" checked={saved.includeSpeaker} onChange={(e) => void save({ includeSpeaker: e.target.checked })} />
        <span>{t.captionsSpeaker}</span>
      </label>

      <fieldset className="captionChannels">
        <legend>{t.captionsChannels}</legend>
        <label className="checkRow">
          <input type="checkbox" checked={saved.channelIds.length === 0} onChange={(e) => e.target.checked && void save({ channelIds: [] })} />
          <span>{t.ruleAllChannels}</span>
        </label>
        {channels.map((c) => (
          <label key={c.id} className="checkRow">
            <input type="checkbox" checked={saved.channelIds.includes(c.id)} onChange={(e) => toggleChannel(c.id, e.target.checked)} />
            <span>{c.name}</span>
          </label>
        ))}
      </fieldset>
      {message && <p className="statusWarn">{message}</p>}
    </div>
  );
}
