import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthScreen } from "./ui.js";

test("Google auth stays hidden when off and follows password auth when on", () => {
  const props = { onAuthenticated: () => undefined, initialMode: "sign-in" as const };
  const dark = renderToStaticMarkup(createElement(AuthScreen, { ...props, googleSignInEnabled: false }));
  assert.match(dark, /type="email"/);
  assert.match(dark, /type="password"/);
  assert.doesNotMatch(dark, /Continue with Google/);

  const enabled = renderToStaticMarkup(createElement(AuthScreen, { ...props, googleSignInEnabled: true }));
  assert.match(enabled, /Continue with Google/);
  assert.ok(enabled.indexOf("Log in") < enabled.indexOf("Continue with Google"));
});
