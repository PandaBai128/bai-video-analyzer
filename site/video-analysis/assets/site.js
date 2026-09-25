(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  const tabButtons = [...document.querySelectorAll('[data-demo-tab]')];
  const demoPanels = [...document.querySelectorAll('.demo-panel')];

  function selectTab(index, focus = false) {
    tabButtons.forEach((button, i) => {
      button.setAttribute('aria-selected', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
      demoPanels[i].hidden = i !== index;
    });
    if (focus) tabButtons[index].focus();
    if (gsap && !reduceMotion.matches) {
      gsap.fromTo(
        demoPanels[index],
        { opacity: 0, y: 5 },
        { opacity: 1, y: 0, duration: 0.25, overwrite: true },
      );
    }
  }
  tabButtons.forEach((button, index) => {
    button.addEventListener('click', () => selectTab(index));
    button.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabButtons.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabButtons.length) % tabButtons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabButtons.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      selectTab(next, true);
    });
  });

  const toast = document.querySelector('.toast');
  let toastTimer;
  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        toast.textContent =
          button.dataset.copy === 'thankyoupanda'
            ? '邀请码复制好了，去插件设置里粘贴吧。'
            : '地址复制好了，在 Chrome 地址栏粘贴打开。';
      } catch {
        toast.textContent = `请手动复制：${button.dataset.copy}`;
      }
      clearTimeout(toastTimer);
      toast.classList.add('is-visible');
      toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
    });
  });

  const frames = [...document.querySelectorAll('[data-frame]')];
  const steps = [...document.querySelectorAll('[data-step]')];
  const frameButtons = [...document.querySelectorAll('[data-show-frame]')];
  const count = document.querySelector('.preview-count');
  const fullShot = document.querySelector('.full-shot');
  let activeFrame = 0;
  function showFrame(index) {
    if (index === activeFrame) return;
    activeFrame = index;
    frames.forEach((frame, i) => {
      frame.classList.toggle('is-active', i === index);
      frame.classList.toggle('is-turned', i < index);
      frame.setAttribute('aria-hidden', String(i !== index));
      steps[i].classList.toggle('is-active', i === index);
      frameButtons[i].setAttribute('aria-pressed', String(i === index));
    });
    count.textContent = `0${index + 1} / 03`;
    fullShot.href = frames[index].querySelector('img').getAttribute('src');

  }
  frameButtons.forEach((button) =>
    button.addEventListener('click', () => showFrame(Number(button.dataset.showFrame))),
  );

  if (!gsap || !ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);
  const media = gsap.matchMedia();

  media.add('(prefers-reduced-motion: no-preference)', () => {
    gsap.from('.hero-enter', {
      opacity: 0,
      y: 18,
      duration: 0.75,
      stagger: 0.07,
      ease: 'power2.out',
      clearProps: 'all',
    });
    gsap.from('.hero-art', {
      opacity: 0,
      y: 26,
      duration: 1,
      delay: 0.15,
      ease: 'power2.out',
      clearProps: 'opacity,transform',
    });
    gsap.from('.floating-note', {
      opacity: 0,
      scale: 0.9,
      duration: 0.6,
      delay: 0.65,
      stagger: 0.14,
      ease: 'back.out(1.4)',
      clearProps: 'opacity,transform',
    });
    document.querySelectorAll('.reveal').forEach((element) => {
      gsap.from(element, {
        opacity: 0,
        y: 24,
        duration: 0.7,
        ease: 'power2.out',
        clearProps: 'opacity,transform',
        scrollTrigger: { trigger: element, start: 'top 92%', once: true },
      });
    });
    gsap.to('.reading-progress', {
      scaleX: 1,
      ease: 'none',
      scrollTrigger: {
        trigger: document.documentElement,
        start: 'top top',
        end: 'bottom bottom',
        scrub: 0.2,
      },
    });
  });

  media.add('(min-width: 801px)', () => {
    steps.forEach((step, index) => {
      ScrollTrigger.create({
        trigger: step,
        start: 'top 55%',
        end: 'bottom 55%',
        onEnter: () => showFrame(index),
        onEnterBack: () => showFrame(index),
      });
    });
    return () => {
      if (gsap) gsap.set(frames, { clearProps: 'opacity,visibility,transform' });
    };
  });

  media.add('(min-width: 801px) and (prefers-reduced-motion: no-preference)', () => {
    gsap.to('.note-top', {
      y: -30,
      rotation: 1,
      ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 1 },
    });
    gsap.to('.note-bottom', {
      y: -55,
      rotation: 0,
      ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 1 },
    });
    gsap.fromTo(
      '.note-paper',
      { rotation: -9, y: 12 },
      {
        rotation: -3,
        y: -8,
        ease: 'none',
        scrollTrigger: {
          trigger: '.notes-section',
          start: 'top bottom',
          end: 'bottom top',
          scrub: 1,
        },
      },
    );
  });

  media.add(
    '(min-width: 801px) and (pointer: fine) and (prefers-reduced-motion: no-preference)',
    (context) => {
      const art = document.querySelector('.hero-art');
      const shell = document.querySelector('[data-tilt]');
      const rotateX = gsap.quickTo(shell, 'rotationX', { duration: 0.65, ease: 'power2.out' });
      const rotateY = gsap.quickTo(shell, 'rotationY', { duration: 0.65, ease: 'power2.out' });
      context.add('move', (event) => {
        const rect = art.getBoundingClientRect();
        rotateX((0.5 - (event.clientY - rect.top) / rect.height) * 5);
        rotateY(((event.clientX - rect.left) / rect.width - 0.5) * 5);
      });
      context.add('leave', () => {
        rotateX(0);
        rotateY(0);
      });
      art.addEventListener('pointermove', context.move);
      art.addEventListener('pointerleave', context.leave);
      return () => {
        art.removeEventListener('pointermove', context.move);
        art.removeEventListener('pointerleave', context.leave);
      };
    },
  );

  window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
  document
    .querySelectorAll('details')
    .forEach((detail) => detail.addEventListener('toggle', () => ScrollTrigger.refresh()));
})();
