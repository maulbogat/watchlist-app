/**
 * Titles mentioned in the project (scripts, examples, conversation context).
 * Format: { imdbId, name } — imdbId is used to fetch full data from OMDb.
 */
const TITLES = [
  { imdbId: "tt10795658", name: "Alice in Borderland" },
  { imdbId: "tt26670955", name: "A Man on the Inside" },
];

const listEl = document.getElementById("title-list");

import { auth, onAuthStateChanged } from "./firebase.js";

function addTitle(imdbId, name) {
  const url = `./add.html?imdbId=${encodeURIComponent(imdbId)}`;
  const a = document.createElement("a");
  a.href = url;
  a.className = "auth-btn";
  a.style.marginRight = "0.5rem";
  a.textContent = `Add ${name}`;
  a.target = "_blank";
  return a;
}

onAuthStateChanged(auth, (user) => {
  listEl.innerHTML = "";
  TITLES.forEach(({ imdbId, name }) => {
    const li = document.createElement("li");
    li.textContent = name;
    li.style.display = "flex";
    li.style.alignItems = "center";
    li.style.gap = "0.5rem";
    const btn = addTitle(imdbId, name);
    li.appendChild(btn);
    listEl.appendChild(li);
  });

  if (!user) {
    const p = document.createElement("p");
    p.style.marginTop = "1rem";
    p.style.color = "var(--muted)";
    p.textContent = "Sign in to add titles. ";
    const signInLink = document.createElement("a");
    signInLink.href = "./";
    signInLink.textContent = "Go to watchlist";
    signInLink.style.color = "var(--accent)";
    p.appendChild(signInLink);
    listEl.after(p);
  }
});
