// Entry point. For now: a capability check so we (and skamlox) can confirm a
// browser can run the app, and a placeholder for the encoder/decoder UI.

interface Capability {
  name: string;
  ok: boolean | "?";
  detail?: string;
}

async function checkCapabilities(): Promise<Capability[]> {
  const caps: Capability[] = [
    { name: "WebCodecs video decode", ok: typeof VideoDecoder !== "undefined" },
    { name: "WebCodecs video encode", ok: typeof VideoEncoder !== "undefined" },
    { name: "Web Audio + AudioWorklet", ok: typeof AudioContext !== "undefined" && "audioWorklet" in AudioContext.prototype },
    { name: "Audio capture (getUserMedia)", ok: !!navigator.mediaDevices?.getUserMedia },
    { name: "Pop-out player (Document PiP)", ok: "documentPictureInPicture" in window },
  ];

  if (typeof VideoDecoder !== "undefined") {
    const codecs: Record<string, string> = {
      "AV1": "av01.0.01M.08",
      "VP9": "vp09.00.10.08",
      "H.264": "avc1.42001E",
    };
    for (const [label, codec] of Object.entries(codecs)) {
      try {
        const s = await VideoDecoder.isConfigSupported({ codec, codedWidth: 256, codedHeight: 144 });
        caps.push({ name: `  codec: ${label}`, ok: !!s.supported });
      } catch {
        caps.push({ name: `  codec: ${label}`, ok: false });
      }
    }
  }
  return caps;
}

function render(caps: Capability[]) {
  const app = document.getElementById("app")!;
  const mark = (ok: boolean | "?") => (ok === true ? "✅" : ok === "?" ? "❔" : "❌");
  app.innerHTML = `
    <h1>Cassette Video Modem</h1>
    <p>Store and play back video on cassette tape (and other audio media) using
       your browser as a software modem. <em>(Rewrite in progress.)</em></p>
    <h2>Your browser</h2>
    <ul style="list-style:none;padding:0;font-family:monospace">
      ${caps.map((c) => `<li>${mark(c.ok)} ${c.name}${c.detail ? " — " + c.detail : ""}</li>`).join("")}
    </ul>
  `;
}

checkCapabilities().then(render);
