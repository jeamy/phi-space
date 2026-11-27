// The reduced copy of a picture for the models (server/images.ts), made in the browser: drawn upright (a phone's
// photo carries its turn in the metadata), the longer side at most 1568 pixels, encoded anew as JPEG. Encoding anew
// drops everything the file carried beside the picture: the camera, the time, the place it was taken. The quality is
// lowered until the copy fits in 400 kB.
import { authHeaders } from "./me.ts";

export const PICTURE = { side: 1568, bytes: 400_000 };

/** The reduced copy of a picture a person chose, as a JPEG blob. Throws when the browser cannot read the file. */
export async function reducePicture(file: Blob): Promise<Blob> {
	const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	try {
		const scale = Math.min(1, PICTURE.side / Math.max(bitmap.width, bitmap.height));
		const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement("canvas");
		canvas.width = w; canvas.height = h;
		const g = canvas.getContext("2d");
		if (!g) throw new Error("the browser cannot draw the picture");
		g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); // a transparent PNG gets a white ground, as JPEG has no transparency
		g.drawImage(bitmap, 0, 0, w, h);
		for (const q of [0.85, 0.75, 0.65, 0.55, 0.45, 0.35]) {
			const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", q));
			if (blob && blob.size <= PICTURE.bytes) return blob;
		}
		throw new Error("the picture does not fit in 400 kB");
	} finally { bitmap.close(); }
}

/** Sends a reduced copy to a task. The ID is drawn once: a second try after a lost reply adds nothing twice. */
export async function sendPicture(rid: string, blockId: string, name: string, blob: Blob): Promise<void> {
	const id = `p${crypto.getRandomValues(new Uint32Array(3)).reduce((s, n) => s + n.toString(36), "")}`.slice(0, 24).padEnd(12, "0");
	const path = `/api/rooms/${rid}/images/${blockId}?id=${id}&name=${encodeURIComponent(name.replace(/\.[^.]*$/, "") + ".jpg")}`;
	for (let attempt = 0; ; attempt++) {
		try {
			const r = await fetch(path, { method: "POST", headers: { "content-type": "image/jpeg", "x-forum-admin": "1", ...authHeaders() }, body: blob });
			const data = await r.json().catch(() => ({}));
			if (!r.ok) throw Object.assign(new Error((data as { error?: string }).error || r.statusText), { final: true });
			return;
		} catch (e) {
			if ((e as { final?: boolean }).final || attempt >= 2) throw e;
			await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
		}
	}
}
