import { els } from "../context.js";
import { renderAll } from "../views.js";

export function currentRoute() {
  return window.location.pathname.replace(/\/+$/, "") === "/check" ? "check" : "home";
}

export function isCheckRoute() {
  return currentRoute() === "check";
}

export function activateRoute(route) {
  const nextPath = route === "check" ? "/check" : "/";
  if (window.location.pathname !== nextPath) {
    window.history.pushState({}, "", nextPath);
  }
  renderAll();
}

export function renderRoute() {
  const route = currentRoute();
  document.body.dataset.route = route;
  els.appWorkspace.hidden = route !== "home";
  els.checkWorkspace.hidden = route !== "check";
  els.routeLinks.forEach((link) => {
    const active = link.dataset.routeLink === route;
    link.classList.toggle("active", active);
    link.setAttribute("aria-current", active ? "page" : "false");
  });
}
