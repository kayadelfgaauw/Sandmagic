// ==========================================================================
// SANDMAGIC — Minimalist Museum Navigation & Dropdown Controller
// ==========================================================================

export function initNavigation() {
  const header = document.querySelector('.site-header');
  const toggleBtn = document.getElementById('navToggle');
  const dropdown = document.getElementById('siteDropdown');
  const backdrop = document.getElementById('dropdownBackdrop');

  if (!header || !toggleBtn || !dropdown) return;

  const toggleText = toggleBtn.querySelector('.nav-toggle-text');

  function openMenu() {
    header.classList.add('menu-open');
    document.body.classList.add('menu-open');
    toggleBtn.setAttribute('aria-expanded', 'true');
    toggleBtn.setAttribute('aria-label', 'Close menu');
    if (toggleText) toggleText.textContent = 'Close';
    dropdown.setAttribute('aria-hidden', 'false');
  }

  function closeMenu() {
    header.classList.remove('menu-open');
    document.body.classList.remove('menu-open');
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.setAttribute('aria-label', 'Open menu');
    if (toggleText) toggleText.textContent = 'Menu';
    dropdown.setAttribute('aria-hidden', 'true');
  }

  function toggleMenu() {
    const isOpen = header.classList.contains('menu-open');
    if (isOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  // Toggle button click
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  // Click on backdrop closes
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      closeMenu();
    });
  }

  // Click outside header closes
  document.addEventListener('click', (e) => {
    if (!header.contains(e.target)) {
      if (header.classList.contains('menu-open')) {
        closeMenu();
      }
    }
  });

  // Escape key closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.classList.contains('menu-open')) {
      closeMenu();
      toggleBtn.focus();
    }
  });

  // Auto-close on viewport resize larger than 900px
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900 && header.classList.contains('menu-open')) {
      closeMenu();
    }
  });

  // Close when clicking any nav link in dropdown
  dropdown.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      closeMenu();
    });
  });

  // Sync active states based on current file/path
  const currentPath = window.location.pathname.split('/').pop() || 'index.html';
  dropdown.querySelectorAll('.dropdown-link').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPath || (currentPath === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNavigation);
} else {
  initNavigation();
}
