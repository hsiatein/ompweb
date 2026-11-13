import { runUtilityCommand } from "@/lib/omp/rpc-utility";
import { mergeLoginMethods, parseLoginProviders } from "@/lib/omp/login-providers";

export const dynamic = "force-dynamic";

// Login-capable providers via the omp RPC get_login_providers command. This is
// omp's own /login list (OAuth subscriptions plus key-creation flows), so no
// hardcoded exclusions or display-name overrides are needed. Alternative login
// methods that store into another provider (ChatGPT device code) are folded
// into that provider as `loginMethods`.
export async function GET() {
  try {
    const response = await runUtilityCommand<{ providers?: unknown }>(
      { type: "get_login_providers" },
      30_000,
    );
    const available = parseLoginProviders(response.providers).filter((p) => p.available);
    const result = mergeLoginMethods(available).map((p) => ({
      id: p.id,
      name: p.name,
      usesCallbackServer: false,
      loggedIn: p.authenticated,
      loginMethods: p.loginMethods,
    }));
    return Response.json({ providers: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ providers: [], error: message }, { status: 500 });
  }
}
