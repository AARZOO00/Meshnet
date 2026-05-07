'use strict';

/**
 * useDeadManSwitch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * React hook that implements a Dead Man Switch for MeshNet.
 *
 * Logic:
 *  - User configures a timeout (1–60 min) and enables the switch
 *  - A countdown timer runs continuously
 *  - User must "check in" (tap I'M OK) before the timer expires
 *  - If the timer hits zero → auto-broadcast SOS with last known GPS location
 *  - Each check-in resets the timer
 *  - Any user activity (message sent, tab switch) optionally resets the timer
 *
 * Phases:
 *   disabled → armed (counting down) → warning (< 20% time left) → triggered
 *
 * Returns:
 *   { phase, secondsLeft, totalSeconds, pct, enable, disable, checkIn,
 *     timeoutMinutes, setTimeoutMinutes, triggerCount, lastCheckIn }
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const PHASES = { DISABLED:'disabled', ARMED:'armed', WARNING:'warning', TRIGGERED:'triggered' };
const WARN_PCT = 0.2;   // enter warning phase when < 20% time remaining

export default function useDeadManSwitch({ router, localNodeId, localUserName, location, batteryLevel }) {
  const [phase,          setPhase]          = useState(PHASES.DISABLED);
  const [timeoutMinutes, setTimeoutMinutes] = useState(5);
  const [secondsLeft,    setSecondsLeft]    = useState(0);
  const [triggerCount,   setTriggerCount]   = useState(0);
  const [lastCheckIn,    setLastCheckIn]    = useState(null);

  const deadlineRef    = useRef(null);   // absolute ms timestamp when timer fires
  const tickTimerRef   = useRef(null);
  const phaseRef       = useRef(PHASES.DISABLED);
  const locationRef    = useRef(location);
  const batteryRef     = useRef(batteryLevel);

  // Keep location/battery refs fresh without restarting the timer
  useEffect(() => { locationRef.current = location; },     [location]);
  useEffect(() => { batteryRef.current  = batteryLevel; }, [batteryLevel]);

  const totalSeconds = timeoutMinutes * 60;

  // ── Trigger: fire the SOS ────────────────────────────────────────────────
  const fireSOS = useCallback(() => {
    phaseRef.current = PHASES.TRIGGERED;
    setPhase(PHASES.TRIGGERED);
    setTriggerCount(n => n + 1);

    if (router) {
      router.broadcast({
        type          : 'SOS',
        userName      : localUserName,
        nodeId        : localNodeId,
        location      : locationRef.current,
        batteryLevel  : batteryRef.current,
        emergencyType : 'DEAD_MAN',
        timestamp     : Date.now(),
        broadcastSeq  : 0,
        deadManSwitch : true,
      });

      // Re-broadcast every 30 s for 5 minutes (10 times) so the mesh hears it
      let rebroadcasts = 0;
      const rbInterval = setInterval(() => {
        rebroadcasts++;
        router.broadcast({
          type          : 'SOS',
          userName      : localUserName,
          nodeId        : localNodeId,
          location      : locationRef.current,
          batteryLevel  : batteryRef.current,
          emergencyType : 'DEAD_MAN',
          timestamp     : Date.now(),
          broadcastSeq  : rebroadcasts,
          deadManSwitch : true,
        });
        if (rebroadcasts >= 10) clearInterval(rbInterval);
      }, 30_000);
    }

    // Browser notification if supported
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('⚠ MESHNET DEAD MAN SWITCH TRIGGERED', {
        body: 'Auto-SOS has been broadcast to all mesh nodes.',
        icon: '/favicon.ico',
        requireInteraction: true,
      });
    }
  }, [router, localNodeId, localUserName]);

  // ── Tick loop ─────────────────────────────────────────────────────────────
  const startTick = useCallback(() => {
    clearInterval(tickTimerRef.current);
    tickTimerRef.current = setInterval(() => {
      const now  = Date.now();
      const left = Math.max(0, Math.round((deadlineRef.current - now) / 1000));
      setSecondsLeft(left);

      const pct = left / totalSeconds;
      if (left <= 0) {
        clearInterval(tickTimerRef.current);
        if (phaseRef.current !== PHASES.TRIGGERED) fireSOS();
      } else if (pct < WARN_PCT && phaseRef.current === PHASES.ARMED) {
        phaseRef.current = PHASES.WARNING;
        setPhase(PHASES.WARNING);
      }
    }, 500);
  }, [fireSOS, totalSeconds]);

  // ── Enable switch ─────────────────────────────────────────────────────────
  const enable = useCallback(() => {
    const deadline = Date.now() + timeoutMinutes * 60_000;
    deadlineRef.current  = deadline;
    phaseRef.current     = PHASES.ARMED;
    setPhase(PHASES.ARMED);
    setSecondsLeft(timeoutMinutes * 60);
    setLastCheckIn(Date.now());

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    startTick();
  }, [timeoutMinutes, startTick]);

  // ── Disable switch ────────────────────────────────────────────────────────
  const disable = useCallback(() => {
    clearInterval(tickTimerRef.current);
    phaseRef.current = PHASES.DISABLED;
    setPhase(PHASES.DISABLED);
    setSecondsLeft(0);
    deadlineRef.current = null;
  }, []);

  // ── Check-in: reset timer ─────────────────────────────────────────────────
  const checkIn = useCallback(() => {
    if (phaseRef.current === PHASES.DISABLED || phaseRef.current === PHASES.TRIGGERED) return;
    const deadline = Date.now() + timeoutMinutes * 60_000;
    deadlineRef.current = deadline;
    phaseRef.current    = PHASES.ARMED;
    setPhase(PHASES.ARMED);
    setSecondsLeft(timeoutMinutes * 60);
    setLastCheckIn(Date.now());
    startTick();
  }, [timeoutMinutes, startTick]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => () => clearInterval(tickTimerRef.current), []);

  // ── Recalculate totalSeconds when timeoutMinutes changes (disabled only) ──
  // (don't restart the timer mid-count)

  const pct = totalSeconds > 0 ? secondsLeft / totalSeconds : 0;

  return {
    phase, secondsLeft, totalSeconds, pct,
    enable, disable, checkIn,
    timeoutMinutes, setTimeoutMinutes,
    triggerCount, lastCheckIn,
    PHASES,
  };
}