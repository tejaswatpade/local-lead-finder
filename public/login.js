const error = new URLSearchParams(window.location.search).get("error");
const errorNode = document.getElementById("loginError");

const messages = {
  "google-not-configured":
    "Google sign-in is not configured yet. Add the Google OAuth client ID and secret in Vercel.",
  "google-cancelled": "Google sign-in was cancelled.",
  "invalid-state": "This sign-in session expired. Try again.",
  "email-not-verified": "This Google account does not have a verified email.",
  "not-allowed": "This Google account is not allowed to access this dashboard.",
  "google-failed": "Google sign-in failed. Try again.",
};

if (errorNode && error) {
  errorNode.textContent = messages[error] || "Sign-in failed. Try again.";
}
