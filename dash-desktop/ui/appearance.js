"use strict";

(() => {
  const key = "dash.appearance";
  const root = document.documentElement;
  let appearance = "light";
  try {
    if (localStorage.getItem(key) === "dark") appearance = "dark";
  } catch {
    // The control still works when local preference storage is unavailable.
  }
  root.dataset.appearance = appearance;

  document.addEventListener("DOMContentLoaded", () => {
    const control = document.getElementById("appearance");
    control.elements.namedItem("appearance").value = appearance;
    control.addEventListener("change", event => {
      const value = event.target.value;
      if (value !== "dark" && value !== "light") return;
      root.dataset.appearance = value;
      try {
        localStorage.setItem(key, value);
      } catch {
        // Keep the user's choice for this window.
      }
    });
  });
})();
