import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        httpEquiv: "Content-Security-Policy",
        content: [
          "default-src 'self'",
          // Inline scripts required by TanStack Start hydration; eval needed by Vite dev + some libs
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.lovable.app https://*.lovable.dev",
          // Tailwind/shadcn inject inline styles
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' data: https://fonts.gstatic.com",
          "img-src 'self' data: blob: https:",
          // App/server calls: Supabase, connector gateway, Google APIs, Lovable AI
          "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://connector-gateway.lovable.dev https://*.googleapis.com https://ai.gateway.lovable.dev",
          "frame-ancestors 'self' https://*.lovable.app https://*.lovable.dev",
          "frame-src 'self' https://*.lovable.app https://*.lovable.dev",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join("; "),
      },
      { name: "referrer", content: "strict-origin-when-cross-origin" },
      
      { httpEquiv: "X-Content-Type-Options", content: "nosniff" },
      { title: "HDP Galvanizing — Production System" },
      { name: "description", content: "Production automation and QC system for HDP galvanizing plants covering loading, dipping, and quality control." },
      { name: "author", content: "HDP Galvanizing" },
      { property: "og:title", content: "HDP Galvanizing — Production System" },
      { property: "og:description", content: "Production automation and QC system for HDP galvanizing plants covering loading, dipping, and quality control." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@Lovable" },
      { name: "twitter:title", content: "HDP Galvanizing — Production System" },
      { name: "twitter:description", content: "Production automation and QC system for HDP galvanizing plants covering loading, dipping, and quality control." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/c7da89a1-40e6-4470-a8b7-3d08386d9d02/id-preview-ba67a997--866a6f70-dc81-44ed-8281-b413c2c1ad5e.lovable.app-1779883575188.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/c7da89a1-40e6-4470-a8b7-3d08386d9d02/id-preview-ba67a997--866a6f70-dc81-44ed-8281-b413c2c1ad5e.lovable.app-1779883575188.png" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const missingEnv =
    typeof window !== "undefined" && !import.meta.env.VITE_SUPABASE_URL;

  return (
    <QueryClientProvider client={queryClient}>
      {missingEnv ? (
        <div
          role="alert"
          style={{
            background: "#b91c1c",
            color: "white",
            padding: "10px 16px",
            fontSize: 14,
            fontFamily: "system-ui, sans-serif",
            textAlign: "center",
          }}
        >
          Backend keys not loaded. Restart the preview to reload environment
          variables. (Lovable Cloud manages the Supabase keys — they won't
          appear in the Secrets panel.)
        </div>
      ) : null}
      <main>
        <Outlet />
      </main>
    </QueryClientProvider>
  );
}
