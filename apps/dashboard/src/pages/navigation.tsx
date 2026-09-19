export function consolePath(path: string): string {
  return `/console${path.startsWith("/") ? path : `/${path}`}`;
}

export function navigate(path: string): void {
  window.history.pushState({}, "", consolePath(path));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function pathWithoutConsole(pathname: string = window.location.pathname): string {
  const path = pathname.startsWith("/console") ? pathname.slice("/console".length) : pathname;
  return path === "" ? "/" : path;
}

export function ConsoleNav() {
  return (
    <nav className="console-nav" aria-label="Console navigation">
      <a href={consolePath("/")}>Fleet</a>
      <a href={consolePath("/repos")}>Repositories</a>
      <a href={consolePath("/onboard")}>Connect repo</a>
    </nav>
  );
}
