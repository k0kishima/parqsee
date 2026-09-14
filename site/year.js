// Extends the footer's copyright year into a range once a later year has
// come: "© 2026" becomes "© 2026–2027" on 1 January 2027. The year written
// in the HTML is the year of first publication and never changes — a
// copyright notice dates the rights, and the range only says the pages are
// still maintained. Without JavaScript the first year alone is shown, which
// is still a correct notice.
for (const el of document.querySelectorAll('[data-since]')) {
  const since = Number(el.dataset.since);
  const now = new Date().getFullYear();
  if (now > since) el.textContent = `${since}–${now}`;
}
