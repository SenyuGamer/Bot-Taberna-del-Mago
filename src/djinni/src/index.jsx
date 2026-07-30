import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { instalarDiscordSync } from "./discordSync";
window.ResizeObserver = ResizeObserver;

/**
 * Main
 */
(function () {
}());

const htmlRoot = document.getElementById("root");
const root = ReactDOM.createRoot(htmlRoot);

instalarDiscordSync();

root.render(
	<App/>
);
