(function () {
  // ── Menu ──
  var menu = document.getElementById('menu');
  var openBtn = document.getElementById('menuOpen');
  var closeBtn = document.getElementById('menuClose');
  if (menu && openBtn && closeBtn) {
    openBtn.addEventListener('click', function () { menu.hidden = false; if (window.lenis) window.lenis.stop(); });
    closeBtn.addEventListener('click', function () { menu.hidden = true; if (window.lenis) window.lenis.start(); });
    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { menu.hidden = true; if (window.lenis) window.lenis.start(); });
    });
  }

  // ── Contact form ──
  var form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      document.getElementById('formOk').hidden = false;
      form.reset();
    });
  }

  // ── Bail if GSAP missing ──
  if (!(window.gsap && window.ScrollTrigger)) return;
  gsap.registerPlugin(ScrollTrigger);

  // ── Lenis smooth scroll + GSAP ticker sync ──
  var navBar = document.querySelector('.nav-bar');
  var lenis = window.lenis = new Lenis({
    lerp: 0.085,
    anchors: { offset: -(navBar ? Math.ceil(navBar.getBoundingClientRect().bottom) : 0) }
  });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
  gsap.ticker.lagSmoothing(0);

  // ── Nav height CSS variable ──
  function measureNav() {
    if (navBar) {
      document.documentElement.style.setProperty(
        '--page-nav-h',
        Math.ceil(navBar.getBoundingClientRect().bottom + 12) + 'px'
      );
    }
  }
  measureNav();
  window.addEventListener('resize', measureNav);

  // ── Easing shortcuts ──
  var expo = 'expo.out';
  var soft = 'power3.out';

  // ── Band rise: clip-path scrub from inset sides to full width on scroll ──
  gsap.utils.toArray('.band').forEach(function (band) {
    var section = band.parentElement;
    var side = innerWidth < 768 ? 2.5 : 4;
    var bigR = Math.round(56 * 2.6);
    gsap.fromTo(band,
      { clipPath: 'inset(0% ' + side + '% 0% ' + side + '% round ' + bigR + 'px ' + bigR + 'px 0px 0px)' },
      { clipPath: 'inset(0% 0% 0% 0% round 56px 56px 0px 0px)',
        ease: 'none',
        scrollTrigger: { trigger: section, start: 'top bottom', end: 'top 25%', scrub: true }
      }
    );
  });

  // ── HERO: parallax exit — media scales up, copy drifts up as you scroll past ──
  var hero = document.getElementById('hero');
  var heroMedia = hero && hero.querySelector('.hero-media');
  var heroCopy = hero && hero.querySelector('.hero-copy');
  if (hero && heroMedia && heroCopy) {
    gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', function () {
      var wide = innerWidth >= 768;
      gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: hero, start: 'bottom bottom', end: 'bottom 20%',
          scrub: true, invalidateOnRefresh: true
        }
      })
      .to(heroMedia, { scale: 1.1, transformOrigin: wide ? '100% 30%' : '62% 30%' }, 0)
      .to(heroCopy, { y: function () { return -innerHeight * (wide ? 0.26 : 0.16); } }, 0);
    });
  }

  // ── Word reveal: word-by-word color scrub ──
  document.querySelectorAll('.word-reveal').forEach(function (el) {
    var words = el.textContent.trim().split(/\s+/);
    el.innerHTML = words.map(function (w) { return '<span class="w">' + w + '</span>'; }).join(' ');
  });
  var wordSpans = document.querySelectorAll('.word-reveal .w');
  if (wordSpans.length) {
    var parent = document.querySelector('.word-reveal');
    var ink = getComputedStyle(parent).color;
    var faint = ink.replace(/^rgb\((.+)\)$/, 'rgba($1, 0.22)');
    gsap.fromTo(wordSpans,
      { color: faint },
      { color: ink, ease: 'none', stagger: 0.12, duration: 0.6,
        scrollTrigger: { trigger: parent, start: 'top 88%', end: 'bottom 60%', scrub: true }
      }
    );
  }

  // ── Section headings: rise + fade ──
  gsap.utils.toArray('.t-h2').forEach(function (el) {
    if (el.closest('#hero')) return;
    gsap.fromTo(el, { opacity: 0, y: 48 },
      { opacity: 1, y: 0, duration: 1, ease: expo,
        scrollTrigger: { trigger: el, start: 'top 88%' } });
  });

  // ── Lead paragraphs ──
  gsap.utils.toArray('.t-lead:not(.word-reveal)').forEach(function (el) {
    if (el.closest('#hero')) return;
    gsap.fromTo(el, { opacity: 0, y: 28 },
      { opacity: 1, y: 0, duration: 0.85, ease: soft,
        scrollTrigger: { trigger: el, start: 'top 88%' } });
  });

  // ── Buttons in head-grids ──
  gsap.utils.toArray('.head-grid .btn').forEach(function (btn) {
    gsap.fromTo(btn, { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.6, ease: soft,
        scrollTrigger: { trigger: btn, start: 'top 90%' } });
  });

  // ── LISTEN: panel entrance with stagger ──
  gsap.utils.toArray('.listen-panel').forEach(function (panel, i) {
    gsap.fromTo(panel, { opacity: 0, y: 48, scale: 0.96 },
      { opacity: 1, y: 0, scale: 1, duration: 0.9, ease: expo, delay: i * 0.15,
        scrollTrigger: { trigger: '.listen-panels', start: 'top 82%' } });
  });
  gsap.utils.toArray('.listen-row').forEach(function (row, i) {
    gsap.fromTo(row, { opacity: 0, x: -24 },
      { opacity: 1, x: 0, duration: 0.65, ease: soft, delay: 0.35 + i * 0.12,
        scrollTrigger: { trigger: '.listen-panels', start: 'top 75%' } });
  });

  // ── CALLS: feature items fade as you scroll, phone step-build ──
  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', function () {
    var items = gsap.utils.toArray('.calls-item');
    var phoneEl = document.querySelector('.phone');
    if (!items.length) return;

    // Phone entrance
    if (phoneEl) {
      gsap.fromTo(phoneEl, { opacity: 0, y: 72, scale: 0.9 },
        { opacity: 1, y: 0, scale: 1, duration: 1.1, ease: expo,
          scrollTrigger: { trigger: '.calls-grid', start: 'top 72%' } });
    }

    // Scroll-linked item highlighting
    var line = innerWidth >= 768 ? '58%' : '52%';
    var tl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: items[0], start: 'top ' + line,
        endTrigger: items[items.length - 1], end: 'bottom ' + line,
        scrub: true
      }
    });
    items.forEach(function (item, i) {
      if (i > 0) tl.fromTo(item, { opacity: 0.32 }, { opacity: 1, duration: 0.25 }, i - 0.1);
      if (i < items.length - 1) tl.to(item, { opacity: 0.32, duration: 0.25 }, i + 0.9);
    });
    tl.to(items.slice(0, -1), { opacity: 1, duration: 0.3 }, items.length - 0.1);
  });

  // ── TUNE: stage entrance + settings row stagger + bars ──
  var tuneStage = document.querySelector('.tune-stage');
  if (tuneStage) {
    gsap.fromTo(tuneStage, { opacity: 0, y: 56, scale: 0.97 },
      { opacity: 1, y: 0, scale: 1, duration: 1, ease: expo,
        scrollTrigger: { trigger: tuneStage, start: 'top 84%' } });
  }
  gsap.utils.toArray('.tune-row').forEach(function (row, i) {
    gsap.fromTo(row, { opacity: 0, x: 24 },
      { opacity: 1, x: 0, duration: 0.55, ease: soft, delay: i * 0.08,
        scrollTrigger: { trigger: row, start: 'top 92%' } });
  });
  gsap.utils.toArray('.bar').forEach(function (bar, i) {
    gsap.fromTo(bar, { scaleY: 0 },
      { scaleY: 1, duration: 0.7, ease: 'back.out(1.4)', delay: i * 0.055,
        scrollTrigger: { trigger: '.bars', start: 'top 90%' } });
  });

  // ── ROOMS: horizontal scroll track ──
  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', function () {
    var root = document.getElementById('rooms');
    var hold = root && root.querySelector('.rooms-hold');
    var track = root && root.querySelector('.rooms-track');
    var places = track ? gsap.utils.toArray(track.querySelectorAll('.room')) : [];
    if (!hold || !track || places.length < 2) return;

    root.classList.add('is-track');
    var travel = function () { return Math.max(0, track.scrollWidth - innerWidth); };
    var setTravel = function () { gsap.set(root, { '--rooms-travel': travel() + 'px' }); };
    setTravel();
    ScrollTrigger.addEventListener('refreshInit', setTravel);

    var main = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: hold, start: 'top top', end: 'bottom bottom',
        scrub: true, invalidateOnRefresh: true
      }
    });
    main.fromTo(track, { x: 0 }, { x: function () { return -travel(); }, duration: 1 }, 0);

    var wide = innerWidth >= 768;
    places.forEach(function (place) {
      var img = place.querySelector('.room-img');
      var talk = place.querySelectorAll('.room-talk > *');
      if (img) {
        gsap.fromTo(img, { xPercent: 7 }, { xPercent: 0, ease: 'none',
          scrollTrigger: { trigger: place, containerAnimation: main,
            start: 'left right', end: wide ? 'left 66%' : 'left 40%', scrub: true } });
      }
      if (talk.length) {
        gsap.fromTo(talk, { y: 36, opacity: 0 }, { y: 0, opacity: 1, ease: 'power2.out', stagger: 0.3,
          scrollTrigger: { trigger: place, containerAnimation: main,
            start: 'left 100%', end: wide ? 'left 66%' : 'left 40%', scrub: true } });
      }
    });

    return function () {
      ScrollTrigger.removeEventListener('refreshInit', setTravel);
      root.classList.remove('is-track');
    };
  });

  // ── Rooms status pill ──
  var roomsNow = document.querySelector('.rooms-now');
  if (roomsNow) {
    gsap.fromTo(roomsNow, { opacity: 0, scale: 0.92 },
      { opacity: 1, scale: 1, duration: 0.6, ease: soft,
        scrollTrigger: { trigger: roomsNow, start: 'top 90%' } });
  }

  // ── VOICES: expert photo clip-path reveal + zoom + parallax cards ──
  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', function () {
    var expertPhotoWrap = document.querySelector('.expert-photo');
    var expertImg = expertPhotoWrap && expertPhotoWrap.querySelector('img');
    var expertQuote = document.querySelector('.voices-expert blockquote');
    var vcards = gsap.utils.toArray('.vcard');

    if (expertPhotoWrap) {
      gsap.fromTo(expertPhotoWrap,
        { clipPath: 'inset(100% 0 0 0 round 1.75rem)' },
        { clipPath: 'inset(0% 0 0 0 round 1.75rem)', duration: 1, ease: expo,
          scrollTrigger: { trigger: expertPhotoWrap, start: 'top 82%' } });
    }
    if (expertImg) {
      gsap.fromTo(expertImg, { scale: 1.2 }, { scale: 1, ease: 'none',
        scrollTrigger: { trigger: expertPhotoWrap, start: 'top bottom', end: 'center 50%', scrub: true } });
    }
    if (expertQuote) {
      gsap.fromTo(expertQuote, { opacity: 0, y: 24 },
        { opacity: 1, y: 0, duration: 0.7, ease: soft,
          scrollTrigger: { trigger: expertQuote, start: 'top 88%' } });
    }

    if (innerWidth >= 768) {
      vcards.forEach(function (card, i) {
        gsap.fromTo(card,
          { y: function () { return innerHeight * (i % 2 ? 0.16 : 0.06); }, x: i % 2 ? 28 : -28 },
          { y: 0, x: 0, ease: 'none',
            scrollTrigger: { trigger: card, start: 'top bottom', end: 'top 58%', scrub: true, invalidateOnRefresh: true } });
      });
    } else {
      vcards.forEach(function (card) {
        gsap.fromTo(card, { opacity: 0, y: 36, scale: 0.96 },
          { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: expo,
            scrollTrigger: { trigger: card, start: 'top 86%' } });
      });
    }
  });

  // ── SETUP: stacking cards ──
  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', function () {
    var root = document.getElementById('setup');
    var steps = root && root.querySelector('.setup-steps');
    var cards = steps ? gsap.utils.toArray(steps.children) : [];
    if (cards.length < 2) return;

    root.classList.add('is-stacked');
    cards.forEach(function (card, i) { card.style.setProperty('--setup-i', i); });

    var gap = function () { return parseFloat(getComputedStyle(steps).rowGap) || 0; };
    var natural = function (idx) {
      var sum = 0;
      for (var j = 0; j < idx; j++) sum += cards[j].offsetHeight + gap();
      return sum;
    };
    var stuck = function (idx) { return parseFloat(getComputedStyle(cards[idx]).top) || 0; };

    cards.slice(0, -1).forEach(function (card, i) {
      gsap.fromTo(card,
        { scale: 1, filter: 'brightness(1)' },
        { scale: 0.92, filter: 'brightness(0.68)', ease: 'none',
          scrollTrigger: {
            trigger: steps,
            start: function () { return 'top+=' + natural(i + 1) + ' bottom'; },
            end: function () { return 'top+=' + natural(i + 1) + ' ' + stuck(i + 1) + 'px'; },
            scrub: true, invalidateOnRefresh: true
          }
        });
    });

    return function () { root.classList.remove('is-stacked'); };
  });

  // ── FAQ: stagger entrance ──
  gsap.utils.toArray('.faq-list details').forEach(function (d, i) {
    gsap.fromTo(d, { opacity: 0, y: 18 },
      { opacity: 1, y: 0, duration: 0.5, ease: soft, delay: i * 0.06,
        scrollTrigger: { trigger: '.faq-list', start: 'top 82%' } });
  });

  // ── START: clip-path expand on scroll ──
  var startWindow = document.querySelector('.start-window');
  if (startWindow) {
    var startImg = startWindow.querySelector('img');
    var wide = innerWidth >= 768;
    var sideX = wide ? 31 : 12;
    var sideY = wide ? 15 : 22;
    var r = 28;

    gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: { trigger: startWindow, start: 'top 92%', end: 'top 10%', scrub: true }
    })
    .fromTo(startWindow,
      { clipPath: 'inset(' + sideY + '% ' + sideX + '% ' + sideY + '% ' + sideX + '% round ' + (r * 3) + 'px)' },
      { clipPath: 'inset(0% 0% 0% 0% round ' + r + 'px)' }, 0)
    .fromTo(startImg, { scale: 1.32 }, { scale: 1 }, 0);
  }

  var startCopy = document.querySelector('.start-copy');
  if (startCopy) {
    gsap.fromTo(startCopy, { opacity: 0, y: 44 },
      { opacity: 1, y: 0, duration: 0.85, ease: expo,
        scrollTrigger: { trigger: startCopy, start: 'top 86%' } });
  }

  // ── CONTACT: photo clip-path reveal + form entrance ──
  var contactPhoto = document.querySelector('.contact-photo');
  if (contactPhoto) {
    gsap.fromTo(contactPhoto,
      { clipPath: 'inset(0 0 100% 0 round 1.75rem)' },
      { clipPath: 'inset(0 0 0% 0 round 1.75rem)', duration: 0.9, ease: expo,
        scrollTrigger: { trigger: contactPhoto, start: 'top 82%' } });
  }
  var contactForm = document.querySelector('.contact-form');
  if (contactForm) {
    gsap.fromTo(contactForm, { opacity: 0, y: 36 },
      { opacity: 1, y: 0, duration: 0.75, ease: soft,
        scrollTrigger: { trigger: contactForm, start: 'top 84%' } });
  }

  // ── FOOTER: giant text + grid entrance ──
  var footerGiant = document.querySelector('.footer-giant');
  if (footerGiant) {
    gsap.fromTo(footerGiant, { opacity: 0, y: 72, scale: 0.95 },
      { opacity: 1, y: 0, scale: 1, duration: 1.1, ease: expo,
        scrollTrigger: { trigger: footerGiant, start: 'top 94%' } });
  }
  var footerGrid = document.querySelector('.footer-grid');
  if (footerGrid) {
    gsap.fromTo(footerGrid, { opacity: 0, y: 32 },
      { opacity: 1, y: 0, duration: 0.8, ease: soft,
        scrollTrigger: { trigger: footerGrid, start: 'top 88%' } });
  }

})();
