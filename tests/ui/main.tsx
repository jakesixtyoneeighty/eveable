import React from "react";
import { createRoot } from "react-dom/client";
import Home from "../../apps/web/src/components/home";
import Workspace from "../../apps/web/src/components/workspace";
import "../../apps/web/src/app/globals.css";
const id = "00000000-0000-4000-8000-000000000001";
createRoot(document.getElementById("root")!).render(
  location.search.includes("home") ? <Home /> : <Workspace id={id} />,
);
