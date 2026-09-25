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
  const count = document.querySelector('.preview-count');
  const fullShot = document.querySelector('.full-shot');
  let activeFrame = 0;
  let requestedFrame = 0;
  let turning = false;
  let storyScroll;
  const pose = (depth) => ({ x: depth * 14, y: depth * 9, rotation: depth * 1.5, scale: 1 - depth * 0.035 });
  function markFrame(index) {
    frames.forEach((frame, i) => {
      frame.classList.toggle('is-active', i === index);
      frame.setAttribute('aria-hidden', String(i !== index));
      steps[i].classList.toggle('is-active', i === index);
    });
    count.textContent = `0${index + 1} / 03`;
    fullShot.href = frames[index].querySelector('img').getAttribute('src');
  }
  function showFrame(index) {
    requestedFrame = index;
    if (turning || index === activeFrame) return;
    const previous = activeFrame;
    const incoming = frames[index];
    if (!gsap || reduceMotion.matches) {
      frames.forEach((frame, i) => {
        const depth = (i - index + frames.length) % frames.length;
        frame.style.setProperty('--depth', String(depth));
        frame.style.zIndex = String(frames.length - depth);
        if (gsap) gsap.set(frame, pose(depth));
      });
      activeFrame = index;
      markFrame(index);
      return;
    }
    turning = true;
    frames.forEach((frame, i) => {
      const depth = (i - previous + frames.length) % frames.length;
      gsap.set(frame, { ...pose(depth), zIndex: frames.length - depth });
    });
    // 先抽出再换层级，完整保留卡片的运动轨迹。
    const direction = index > previous ? 1 : -1;
    const distance = incoming.getBoundingClientRect().width * 0.32;
    const turn = gsap.timeline({
      onComplete: () => {
        activeFrame = index;
        turning = false;
        if (requestedFrame !== activeFrame) showFrame(requestedFrame);
      },
    });
    turn.to(incoming, { x: direction * distance, y: -18, rotation: direction * 7, scale: 0.98, duration: 0.28, ease: 'power2.inOut' });
    turn.call(() => {
      frames.forEach((frame, i) => {
        const depth = (i - index + frames.length) % frames.length;
        frame.style.zIndex = String(frames.length - depth);
      });
      markFrame(index);
    });
    frames.forEach((frame, i) => {
      const depth = (i - index + frames.length) % frames.length;
      turn.to(frame, { ...pose(depth), duration: 0.38, ease: 'power2.out' }, 0.28);
    });
  }

  const dialog = document.querySelector('#screenshot-dialog');
  const dialogImage = dialog.querySelector('img');
  document.querySelectorAll('.full-shot, .mobile-shot').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      dialogImage.src = link.href;
      dialog.showModal();
    });
  });
  dialog.querySelector('button').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.classList.contains('shot-backdrop')) dialog.close();
  });
  document.querySelectorAll('[data-show-frame]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.showFrame);
      if (storyScroll) {
        window.scrollTo({ top: storyScroll.start + (index + 0.5) * (storyScroll.end - storyScroll.start) / 3, behavior: 'instant' });
      } else {
        steps[index].querySelector('.mobile-shot').scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      showFrame(index);
    });
  });

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
    storyScroll = ScrollTrigger.create({
      trigger: '.experience',
      start: 'top 100px',
      end: '+=1050',
      pin: true,
      onUpdate: (self) => showFrame(Math.min(2, Math.floor(self.progress * 3))),
      onLeaveBack: () => showFrame(0),
    });
    return () => { storyScroll = null; };
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
