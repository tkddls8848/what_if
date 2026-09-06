import { els } from "../context.js";
import { renderAll } from "../views.js";

// "/"는 이제 랜딩 페이지 몫이다. 분석기의 home 화면은 /analyze에 산다. 그래도
// /check가 아닌 경로는 전부 home으로 취급해, 오래된 "/" 북마크로 이 페이지가
// 열려도(정적 미들웨어가 index.html을 내려주는 예외적 상황 등) 라우터가 깨지지 않게 한다.
export function currentRoute() {
  return window.location.pathname.replace(/\/+$/, "") === "/check" ? "check" : "home";
}

export function isCheckRoute() {
  return currentRoute() === "check";
}

export function activateRoute(route) {
  const nextPath = route === "check" ? "/check" : "/analyze";
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
