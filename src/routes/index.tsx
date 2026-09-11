import { createFileRoute } from "@tanstack/react-router";
import { Component, type ReactNode } from "react";
import HdpApp from "@/features/hdp/HdpApp";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "HDP Galvanizing — Production System" },
      { name: "description", content: "Hot Dip Galvanizing plant production automation: loading, dipping, QC, and reporting." },
      { property: "og:title", content: "HDP Galvanizing — Production System" },
      { property: "og:description", content: "Hot Dip Galvanizing plant production automation: loading, dipping, QC, and reporting." },
      { property: "og:url", content: "https://kanchigalvanizing.lovable.app/" },
    ],
    links: [
      { rel: "canonical", href: "https://kanchigalvanizing.lovable.app/" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <HdpAppErrorBoundary>
      <HdpApp />
    </HdpAppErrorBoundary>
  );
}

class HdpAppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[boot] HdpApp render failed", error);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main style={{ minHeight: "100vh", background: "#04080F", color: "#DDE8F8", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "system-ui,-apple-system,sans-serif", textAlign: "center" }}>
        <div style={{ maxWidth: 420 }}>
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>App failed to start</div>
          <div style={{ color: "#5A7599", fontSize: 13, lineHeight: 1.6, marginBottom: 18 }}>Please reload the app. If this keeps happening, the startup error has been logged for diagnosis.</div>
          <button onClick={() => window.location.reload()} style={{ padding: "10px 18px", borderRadius: 6, border: "none", background: "#E8A020", color: "#04080F", fontWeight: 800, cursor: "pointer" }}>
            Reload app
          </button>
        </div>
      </main>
    );
  }
}
