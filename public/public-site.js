(async () => {
  try {
    const response = await fetch("/api/state", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return;

    document.documentElement.classList.add("is-authenticated");
    document.querySelectorAll('a[href="/login"]').forEach((link) => {
      const text = link.textContent.trim().toLowerCase();
      link.href = "/dashboard";

      if (link.classList.contains("nav-cta")) {
        link.textContent = "Dashboard";
      } else if (text.includes("try")) {
        link.textContent = "New search";
      } else {
        link.textContent = "Go to dashboard";
      }
    });
  } catch {
    // Public pages should stay usable if the session check is unavailable.
  }
})();
