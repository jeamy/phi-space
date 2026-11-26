/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Field help of the page: every control with a `data-tip` shows its description above it, on hover after a short delay
// and at once on keyboard focus (on a phone, focusing a field shows it); the help button in the header opens the
// detailed description (the <dialog id="help"> in index.html). One tip element for the whole page, positioned through
// the CSSOM, since the content security policy allows no inline styles.
export {};

const tip = document.createElement("div");
tip.className = "tip";
tip.id = "tip";
tip.setAttribute("role", "tooltip");
tip.hidden = true;
document.body.append(tip);

let shownFor: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function showTip(el: HTMLElement): void {
	const text = el.dataset.tip;
	if (!text) return;
	clearTimeout(timer);
	shownFor = el;
	tip.textContent = text;
	tip.hidden = false;
	el.setAttribute("aria-describedby", "tip");
	tip.style.left = "0px"; tip.style.top = "0px"; // measured at the left edge, so its width does not depend on where it was
	const r =el.getBoundingClientRect(), t = tip.getBoundingClientRect(), gap = 8, edge = 8;
	const left = Math.min(Math.max(edge, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - edge);
	// above the field; below it when there is no room above
	const above = r.top - t.height - gap >= edge;
	tip.classList.toggle("below", !above);
	tip.style.left = `${left}px`;
	tip.style.top = `${above ? r.top - t.height - gap : r.bottom + gap}px`;
	tip.style.setProperty("--arrow", `${Math.min(Math.max(12, r.left + r.width / 2 - left), t.width - 12)}px`);
}
function hideTip(): void {
	clearTimeout(timer);
	shownFor?.removeAttribute("aria-describedby");
	shownFor = null;
	tip.hidden = true;
}
const tipped = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;

document.addEventListener("pointerover", (e) => {
	if (e.pointerType !== "mouse") return;
	const el = tipped(e.target);
	if (!el || el === shownFor) return;
	clearTimeout(timer);
	timer = setTimeout(() => showTip(el), 350);
});
document.addEventListener("pointerout", (e) => {
	const el = tipped(e.target);
	if (el && !el.contains(e.relatedTarget as Node | null) && document.activeElement !== el) hideTip();
});
document.addEventListener("focusin", (e) => { const el = tipped(e.target); if (el) showTip(el); else hideTip(); });
document.addEventListener("focusout", (e) => { if (tipped(e.target) === shownFor) hideTip(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
window.addEventListener("scroll", hideTip, true);
window.addEventListener("resize", hideTip);

// the detailed description
const dialog = document.getElementById("help") as HTMLDialogElement | null;
document.getElementById("help-open")?.addEventListener("click", () => { hideTip(); dialog?.showModal(); });
document.getElementById("help-close")?.addEventListener("click", () => dialog?.close());
// a click on the backdrop (outside the dialog's box) closes it too
dialog?.addEventListener("click", (e) => {
	const r = dialog.getBoundingClientRect();
	if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
});
