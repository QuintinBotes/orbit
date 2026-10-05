const select = document.getElementById('status');
const body = document.getElementById('rows');
const count = document.getElementById('count');

async function load() {
  const res = await fetch(`/api/reports?status=${encodeURIComponent(select.value)}`);
  const list = await res.json();
  body.replaceChildren(
    ...list.map((r) => {
      const tr = document.createElement('tr');
      for (const value of [r.id, r.name, r.status, r.amount]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      return tr;
    }),
  );
  count.textContent = `${list.length} reports`;
}

select.addEventListener('change', load);
// The browser treats the attachment response as a download and stays on the page.
document.getElementById('export').addEventListener('click', () => {
  window.location.assign(`/export.csv?status=${encodeURIComponent(select.value)}`);
});

if (window.__APP__ && window.__APP__.noise) {
  console.error('legacy widget failed to initialise');
  fetch('/api/missing');
}
load();
