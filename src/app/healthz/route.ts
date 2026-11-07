// Health check for the load balancer. Returns no data about students.
export const dynamic = "force-dynamic";

export function GET() {
  return new Response("ok", { status: 200 });
}
