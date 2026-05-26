const menuButton = document.querySelector(".menu-button");
const navLinks = document.querySelectorAll(".nav a");
const sections = [...document.querySelectorAll(".snap-section")];
const dots = [...document.querySelectorAll(".page-dots a")];

menuButton?.addEventListener("click", () => {
  const isOpen = document.body.classList.toggle("menu-open");
  menuButton.setAttribute("aria-expanded", String(isOpen));
});

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    document.body.classList.remove("menu-open");
    menuButton?.setAttribute("aria-expanded", "false");
  });
});

const setActiveSection = (id) => {
  dots.forEach((dot) => {
    const isActive = dot.dataset.sectionDot === id;
    dot.classList.toggle("is-active", isActive);
    dot.setAttribute("aria-current", isActive ? "true" : "false");
  });
};

dots.forEach((dot) => {
  dot.addEventListener("click", (event) => {
    event.preventDefault();
    const target = document.getElementById(dot.dataset.sectionDot);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(dot.dataset.sectionDot);
  });
});

// update active dot on scroll
const sectionObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) setActiveSection(entry.target.id);
    });
  },
  { threshold: 0.4 }
);
sections.forEach((s) => sectionObserver.observe(s));

// scroll-triggered reveal
const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12 }
);
document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));
