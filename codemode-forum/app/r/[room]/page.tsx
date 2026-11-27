import { ForumPage } from "../../../client/forum/ForumPage.tsx";
import "../../../client/styles/page.css";

/** A room by its name in the path, /r/<room>, so that a link to it can be sent. */
export default async function Page({ params }: { params: Promise<{ room: string }> }) {
	const { room } = await params;
	let name = room;
	try { name = decodeURIComponent(room); } catch { /* a name with a stray % stays as it came */ }
	return <ForumPage place="room" room={name} />;
}
