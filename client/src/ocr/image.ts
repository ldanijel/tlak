/** Učitavanje fotografije u <img> (Safari dekodira i HEIC), uz automatsku EXIF orijentaciju preglednika. */
export function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Preglednik ne može otvoriti ovu fotografiju (format nije podržan).')); };
    img.src = url;
  });
}

/** Smanjuje sliku na najviše maxSide px (duža stranica) i vraća canvas. */
export function toCanvas(img: HTMLImageElement, maxSide = 1600): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export interface Rect { x: number; y: number; w: number; h: number }

export function cropRotate(src: HTMLCanvasElement, rect: Rect, rotation: 0 | 90 | 180 | 270): HTMLCanvasElement {
  const cropped = document.createElement('canvas');
  cropped.width = Math.max(1, Math.round(rect.w));
  cropped.height = Math.max(1, Math.round(rect.h));
  cropped.getContext('2d')!.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, cropped.width, cropped.height);
  if (!rotation) return cropped;
  const out = document.createElement('canvas');
  const swap = rotation === 90 || rotation === 270;
  out.width = swap ? cropped.height : cropped.width;
  out.height = swap ? cropped.width : cropped.height;
  const ctx = out.getContext('2d')!;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(cropped, -cropped.width / 2, -cropped.height / 2);
  return out;
}

/**
 * Čita EXIF DateTimeOriginal iz JPEG datoteke (APP1). Vraća lokalni Date ili null.
 * HEIC i PNG nemaju ovdje čitljive metapodatke – tada se koristi trenutačno vrijeme uz jasnu napomenu.
 */
export async function exifDate(file: Blob): Promise<Date | null> {
  try {
    const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (buf.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < buf.byteLength) {
      const marker = buf.getUint16(off);
      const len = buf.getUint16(off + 2);
      if (marker === 0xffe1 && buf.getUint32(off + 4) === 0x45786966) {
        const tiff = off + 10;
        const little = buf.getUint16(tiff) === 0x4949;
        const u16 = (p: number) => buf.getUint16(p, little);
        const u32 = (p: number) => buf.getUint32(p, little);
        const readDir = (dir: number): Date | null => {
          const n = u16(dir);
          for (let i = 0; i < n; i++) {
            const e = dir + 2 + i * 12;
            const tag = u16(e);
            if (tag === 0x8769) { const d = readDir(tiff + u32(e + 8)); if (d) return d; }
            if (tag === 0x9003 || tag === 0x0132) {
              const count = u32(e + 4);
              const p = tiff + u32(e + 8);
              let s = '';
              for (let k = 0; k < Math.min(count, 19); k++) s += String.fromCharCode(buf.getUint8(p + k));
              const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
              if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
            }
          }
          return null;
        };
        return readDir(tiff + u32(tiff + 4));
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch { /* ignoriraj */ }
  return null;
}
