/**
 * Voice-note recording, ported from the v1 app:
 *  - mime preference order matters for cross-browser support
 *  - Evolution rejects data: URLs whose mime carries params
 *    (audio/webm;codecs=opus), so we send the RAW base64 payload only.
 */

const MIME_PREFERENCE = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MIME_PREFERENCE.find((t) => MediaRecorder.isTypeSupported(t));
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  /** Stop and return the raw base64 audio payload (no data: prefix) plus its mime. */
  async stop(): Promise<{ base64: string; mime: string }> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('not recording');
    const mime = recorder.mimeType || 'audio/webm';
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: mime }));
      recorder.stop();
    });
    this.cleanup();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    return { base64: dataUrl.replace(/^data:[^,]*,/, ''), mime };
  }

  cancel(): void {
    try {
      this.recorder?.stop();
    } catch {
      /* already stopped */
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}

/** Read a File as raw base64 (no data: prefix) — for media compose/send. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
