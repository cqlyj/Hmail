// The house's Google desktop client. Google treats a desktop client secret as not
// confidential; it is served here only so it stays out of the repository. The house
// does the token exchange itself, so tokens never pass through this project.
const CLIENT_ID =
  "399441327945-npv5vju5ks0cpf5majbfeh97op5igs5i.apps.googleusercontent.com";

export default {
  async fetch(request) {
    if (request.method !== "GET") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const secret = process.env.GOOGLE_CLIENT_SECRET;
    if (typeof secret !== "string" || secret.length === 0) {
      return Response.json({ error: "not configured" }, { status: 500 });
    }
    return Response.json(
      { client_id: CLIENT_ID, client_secret: secret },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
};
