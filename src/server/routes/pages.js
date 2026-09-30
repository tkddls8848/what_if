"use strict";
const express = require("express");
const path = require("path");
const { ROOT } = require("../settings");

/** 저장소 전체를 공개하지 않는다. 브라우저가 사용하는 자산만 제공한다. */
module.exports = function registerPages(app) {
  for (const [routes, file] of [
    [["/", "/play", "/play.html"], "play.html"],
    [["/analyze", "/analyze/check", "/index.html"], "index.html"],
    [["/worlds", "/check", "/session", "/library.html"], "library.html"]
  ]) app.get(routes, (_req, res) => res.sendFile(path.join(ROOT, file)));

  for (const file of ["styles.css", "story.css", "src/analyzer.js", "src/config.js"]) {
    app.get(`/${file}`, (_req, res) => res.sendFile(path.join(ROOT, file)));
  }
  for (const directory of ["src/app", "src/core", "src/analysis", "texts", "data/scenes"]) {
    app.use(`/${directory}`, express.static(path.join(ROOT, directory), { index: false, dotfiles: "deny" }));
  }
};
