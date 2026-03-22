import { auth, signInWithPopup, GoogleAuthProvider, fbSignOut, setUserCountry } from "../../firebase.js";
import { userCountryCode, setUserCountryCode } from "../store/state.js";
import { showCountryModal, updateCountryDropdownRow } from "./country-modal.js";

export function updateAuthUI(user) {
  const signInBtn = document.getElementById("sign-in-btn");
  const signedIn = document.getElementById("signed-in");
  const avatarImg = document.getElementById("auth-avatar-img");
  const avatarInitial = document.getElementById("auth-avatar-initial");
  const avatarBtn = document.getElementById("auth-avatar-btn");

  if (user) {
    signInBtn.style.display = "none";
    signedIn.style.display = "flex";
    if (avatarBtn) avatarBtn.title = "Signed in as " + (user.email || user.displayName || "you");
    const initial = (user.displayName || user.email || "?").charAt(0).toUpperCase();
    if (avatarInitial) avatarInitial.textContent = initial;
    if (user.photoURL && avatarImg && avatarInitial) {
      avatarImg.alt = user.displayName || user.email || "Avatar";
      avatarImg.onerror = () => {
        avatarImg.style.display = "none";
        avatarImg.src = "";
        avatarImg.onerror = null;
        avatarInitial.style.display = "";
      };
      avatarImg.src = user.photoURL;
      avatarImg.style.display = "";
      avatarInitial.style.display = "none";
    } else if (avatarInitial && avatarImg) {
      avatarInitial.style.display = "";
      avatarImg.style.display = "none";
      avatarImg.src = "";
      avatarImg.onerror = null;
    }
  } else {
    signInBtn.style.display = "inline-flex";
    signedIn.style.display = "none";
    if (avatarInitial) avatarInitial.textContent = "";
  }
}

export function wireAuthListeners() {
  const authAvatarWrap = document.getElementById("signed-in");
  const authAvatarBtn = document.getElementById("auth-avatar-btn");
  const authDropdown = document.getElementById("auth-dropdown");

  document.getElementById("sign-in-btn").addEventListener("click", async () => {
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Sign-in error:", err);
      const msg =
        err.code === "auth/unauthorized-domain"
          ? "Add this domain in Firebase Console → Authentication → Settings → Authorized domains: " + window.location.hostname
          : err.message || "Sign-in failed. Please try again.";
      alert(msg);
    }
  });

  if (authAvatarBtn && authDropdown) {
    authAvatarBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = authDropdown.getAttribute("aria-hidden") === "false";
      authAvatarBtn.setAttribute("aria-expanded", !open);
      authDropdown.setAttribute("aria-hidden", open);
    });
    document.addEventListener("click", (e) => {
      if (authAvatarWrap && !authAvatarWrap.contains(e.target)) {
        authAvatarBtn?.setAttribute("aria-expanded", "false");
        authDropdown?.setAttribute("aria-hidden", "true");
      }
    });
  }

  document.getElementById("auth-signout-btn")?.addEventListener("click", () => {
    authDropdown?.setAttribute("aria-hidden", "true");
    authAvatarBtn?.setAttribute("aria-expanded", "false");
    fbSignOut(auth);
  });

  document.getElementById("auth-country-btn")?.addEventListener("click", async () => {
    authDropdown?.setAttribute("aria-hidden", "true");
    authAvatarBtn?.setAttribute("aria-expanded", "false");
    const user = auth.currentUser;
    if (!user) return;
    await showCountryModal({
      initialCode: userCountryCode,
      onSave: async (code, name) => {
        await setUserCountry(user.uid, code, name);
        setUserCountryCode(code);
        updateCountryDropdownRow();
      },
    });
  });

  document.getElementById("auth-switch-btn")?.addEventListener("click", async () => {
    authDropdown?.setAttribute("aria-hidden", "true");
    authAvatarBtn?.setAttribute("aria-expanded", "false");
    await fbSignOut(auth);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (err) {
      if (err.code !== "auth/cancelled-popup-request" && err.code !== "auth/popup-closed-by-user") {
        console.error("Switch account error:", err);
        alert(err.message || "Failed to switch account.");
      }
    }
  });
}
