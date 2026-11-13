import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated, Easing, Platform, Pressable, SafeAreaView, StyleSheet, Text, Vibration, View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Haptics from "expo-haptics";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import { VolumeManager } from "react-native-volume-manager";

const DURATION = 5000;
const BARS = 64;
const C = {
  bg: "#07100d", panel: "#0d1a16", line: "#1c3a31", fg: "#d6f5e6", dim: "#6f9a8a",
  scan: "#3dffb0", truth: "#2bff7a", lie: "#ff3b4e",
};

// one cardiac cycle, p in 0..1
function ecg(p) {
  if (p < 0.1) return 0.12 * Math.sin((p / 0.1) * Math.PI);
  if (p < 0.16) return 0;
  if (p < 0.19) return -0.18 * ((p - 0.16) / 0.03);
  if (p < 0.24) return -0.18 + 1.18 * ((p - 0.19) / 0.05);
  if (p < 0.29) return 1.0 - 1.35 * ((p - 0.24) / 0.05);
  if (p < 0.33) return -0.35 + 0.35 * ((p - 0.29) / 0.04);
  if (p < 0.5) return 0;
  if (p < 0.68) return 0.22 * Math.sin(((p - 0.5) / 0.18) * Math.PI);
  return 0;
}

export default function App() {
  useKeepAwake();
  const beat = useAudioPlayer(require("./assets/sounds/beat.wav"));
  const startSnd = useAudioPlayer(require("./assets/sounds/start.wav"));
  const truthSnd = useAudioPlayer(require("./assets/sounds/truth.wav"));
  const lieSnd = useAudioPlayer(require("./assets/sounds/lie.wav"));

  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null); // "truth" | "lie" | null
  const [bpm, setBpm] = useState(null);
  const [trace, setTrace] = useState(() => new Array(BARS).fill(0));
  const [hint, setHint] = useState("اطلب من صديقك وضع إصبعه على البصمة واسأله سؤالاً");
  const [mode, setMode] = useState("secret"); // "secret" | "random"
  const [flashOn, setFlashOn] = useState(false);
  const [panel, setPanel] = useState(false);
  const [forcedView, setForcedView] = useState(null);
  const [camPerm, requestCamPerm] = useCameraPermissions();

  const forced = useRef(null);
  const modeRef = useRef("secret");
  const scanRef = useRef(false);
  const t0 = useRef(0);
  const phase = useRef(0);
  const timers = useRef({});
  const lastVol = useRef(null);
  const volSub = useRef(null);
  const logoTaps = useRef({ n: 0, t: null });
  const pulse = useRef(new Animated.Value(0)).current;
  const flash = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;
  const pulseAnimation = useRef(null);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
    return () => {
      Object.values(timers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
      clearInterval(timers.current.tick);
      pulseAnimation.current?.stop();
      volSub.current?.remove();
      VolumeManager.showNativeVolumeUI({ enabled: true }).catch(() => {});
    };
  }, []);

  const play = (p) => {
    try {
      Promise.resolve(p.seekTo(0)).then(() => p.play()).catch(() => {});
    } catch (e) {}
  };
  const setForced = (v) => { forced.current = v; setForcedView(v); };

  // ECG animation + BPM while scanning
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      let sample = (Math.random() - 0.5) * 0.01;
      if (scanRef.current) {
        const e = Math.min(1, (now - t0.current) / DURATION);
        const rate = (72 + e * 66) / 60;
        phase.current = (phase.current + (rate * 50) / 1000) % 1;
        const amp = 0.5 + 0.5 * e;
        sample = ecg(phase.current) * amp + (Math.random() - 0.5) * 0.03 * amp;
        setBpm(Math.round(72 + e * 66 + Math.sin(now / 180) * 3));
      }
      setTrace((t) => { const n = t.slice(1); n.push(sample); return n; });
    }, 50);
    return () => clearInterval(id);
  }, []);

  const stopVolume = useCallback(async () => {
    try { volSub.current && volSub.current.remove(); volSub.current = null; await VolumeManager.showNativeVolumeUI({ enabled: true }); } catch (e) {}
  }, []);

  const startVolume = useCallback(async () => {
    try {
      await VolumeManager.showNativeVolumeUI({ enabled: false });
      if (!scanRef.current) {
        await VolumeManager.showNativeVolumeUI({ enabled: true });
        return;
      }
      await VolumeManager.setVolume(0.5, { showUI: false });
      if (!scanRef.current) {
        await VolumeManager.showNativeVolumeUI({ enabled: true });
        return;
      }
      lastVol.current = 0.5;
      volSub.current = VolumeManager.addVolumeListener(({ volume }) => {
        if (lastVol.current == null) { lastVol.current = volume; return; }
        if (volume > lastVol.current) setForced("truth");
        else if (volume < lastVol.current) setForced("lie");
        lastVol.current = volume;
      });
    } catch (e) {
      VolumeManager.showNativeVolumeUI({ enabled: true }).catch(() => {});
    }
  }, []);

  const scheduleBeat = useCallback(() => {
    if (!scanRef.current) return;
    const e = Math.min(1, (Date.now() - t0.current) / DURATION);
    play(beat);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    if (Platform.OS === "android") Vibration.vibrate(60 + Math.round(e * 140));
    timers.current.beat = setTimeout(scheduleBeat, 60000 / (72 + e * 66));
  }, [beat]);

  const finish = useCallback(() => {
    clearTimeout(timers.current.beat);
    clearTimeout(timers.current.end);
    scanRef.current = false;
    setScanning(false);
    setBpm(null);
    pulseAnimation.current?.stop();
    pulseAnimation.current = null;
    progress.setValue(1);
    const r = modeRef.current === "secret" && forced.current ? forced.current : Math.random() < 0.5 ? "truth" : "lie";
    setForced(null);
    setResult(r);
    setHint("ارفع إصبعك. اضغط مجدداً لفحص جديد");
    stopVolume();
    if (r === "truth") { play(truthSnd); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); }
    else { play(lieSnd); Vibration.vibrate([0, 400, 100, 400]); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}); }
    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 900, useNativeDriver: false }).start();
  }, [flash, lieSnd, progress, truthSnd, stopVolume]);

  const start = useCallback(() => {
    if (scanRef.current) return;
    scanRef.current = true;
    t0.current = Date.now();
    phase.current = 0;
    setResult(null);
    setScanning(true);
    progress.setValue(0);
    setHint("ابقِ إصبعك ثابتاً... أجب عن السؤال");
    play(startSnd);
    scheduleBeat();
    startVolume();
    pulse.setValue(0);
    const animation = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 800, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    pulseAnimation.current = animation;
    animation.start();
    Animated.timing(progress, { toValue: 1, duration: DURATION, easing: Easing.linear, useNativeDriver: false }).start();
    timers.current.end = setTimeout(finish, DURATION);
  }, [finish, progress, pulse, scheduleBeat, startSnd, startVolume]);

  const cancel = useCallback(() => {
    if (!scanRef.current) return;
    scanRef.current = false;
    clearTimeout(timers.current.beat);
    clearTimeout(timers.current.end);
    Vibration.cancel();
    pulseAnimation.current?.stop();
    pulseAnimation.current = null;
    pulse.setValue(0);
    progress.stopAnimation();
    progress.setValue(0);
    setScanning(false);
    setBpm(null);
    setHint("رفعت إصبعك مبكراً. أعد المحاولة وابقَ ثابتاً 5 ثوانٍ");
    setForced(null);
    stopVolume();
  }, [progress, pulse, stopVolume]);

  const onLogo = () => {
    const s = logoTaps.current;
    s.n += 1; clearTimeout(s.t); s.t = setTimeout(() => { s.n = 0; }, 700);
    if (s.n >= 3) { s.n = 0; setPanel((p) => !p); }
  };

  const toggleFlash = async () => {
    if (!flashOn) {
      const p = camPerm && camPerm.granted ? camPerm : await requestCamPerm();
      if (!p || !p.granted) return;
    }
    setFlashOn((f) => !f);
  };

  const bg = flash.interpolate({ inputRange: [0, 1], outputRange: [C.bg, result === "lie" ? "#2c0910" : "#072a16"] });
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] });
  const progressWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });
  const bars = useMemo(() => trace.map((v, i) => (
    <View key={i} style={[s.bar, { height: Math.max(2, 28 + v * 40), opacity: 0.35 + (i / BARS) * 0.65 }]} />
  )), [trace]);
  const nextLabel = mode === "random" ? "عشوائية" : forcedView === "truth" ? "حقيقة" : forcedView === "lie" ? "كذب" : "عشوائية (لم تحدد بعد)";

  return (
    <Animated.View style={[s.root, { backgroundColor: bg }]}>
      <StatusBar style="light" />
      <SafeAreaView style={s.safe}>
        <View style={s.header}>
          <Pressable onPress={onLogo} hitSlop={8}><Text style={s.logo}>كاشف <Text style={{ color: C.scan }}>الكذب</Text></Text></Pressable>
          <View style={s.status}>
            <View style={[s.dot, scanning && { backgroundColor: C.lie }]} />
            <Text style={s.statusTxt}>{scanning ? "جارٍ الفحص" : result ? "اكتمل الفحص" : "جاهز"}</Text>
          </View>
        </View>

        <View style={s.monitor}>
          <View style={s.monitorTop}>
            <Text style={s.mono}>ECG · LEAD II</Text>
            <Text style={s.bpm}>{bpm ?? "--"} <Text style={s.mono}>BPM</Text></Text>
          </View>
          <View style={s.wave}>{bars}</View>
        </View>

        <View style={s.stage}>
          <Text style={s.hint}>{hint}</Text>
          <View style={s.padWrap}>
            {scanning && <Animated.View style={[s.ring, { transform: [{ scale: ringScale }], opacity: ringOpacity }]} />}
            <Pressable
              onPressIn={start}
              onPressOut={cancel}
              style={[s.pad, scanning && s.padOn]}
              accessibilityRole="button"
              accessibilityLabel="ضع إصبعك هنا للفحص"
            >
              {[0.9, 0.72, 0.54, 0.36, 0.18].map((k, i) => (
                <View key={i} style={[s.print, { width: `${k * 100}%`, height: `${k * 100}%`, borderColor: scanning ? C.scan : C.dim }]} />
              ))}
            </Pressable>
          </View>
          <View style={s.progress}><Animated.View style={[s.progressFill, { width: progressWidth }]} /></View>
        </View>

        <View style={s.result}>
          {result && (
            <>
              <Text style={[s.word, { color: result === "truth" ? C.truth : C.lie }]}>{result === "truth" ? "حقيقة" : "كذب"}</Text>
              <Text style={s.mono}>{result === "truth" ? "STRESS 12% · VERDICT: TRUTH" : "STRESS 94% · VERDICT: DECEPTION"}</Text>
            </>
          )}
        </View>
        <Text style={s.disclaimer}>للتسلية فقط. هذا التطبيق لا يكشف الكذب فعلياً.</Text>
      </SafeAreaView>

      {/* invisible control zones: bottom-left = truth, bottom-right = lie */}
      <Pressable style={[s.zone, { left: 0 }]} onPressIn={() => scanRef.current && setForced("truth")} />
      <Pressable style={[s.zone, { right: 0 }]} onPressIn={() => scanRef.current && setForced("lie")} />

      {flashOn && scanning && camPerm && camPerm.granted && (
        <CameraView style={s.cam} facing="back" enableTorch />
      )}

      {panel && (
        <View style={s.panel}>
          <Text style={s.panelTitle}>لوحة التحكم السرية</Text>
          <Text style={s.panelTxt}>أثناء الفحص: اضغط زر رفع الصوت أو الزاوية السفلية اليسرى لنتيجة «حقيقة». اضغط زر خفض الصوت أو الزاوية السفلية اليمنى لنتيجة «كذب». إن لم تضغط شيئاً تظهر نتيجة عشوائية.</Text>
          <View style={s.seg}>
            <Pressable style={[s.segBtn, mode === "secret" && s.segOn]} onPress={() => setMode("secret")}><Text style={[s.segTxt, mode === "secret" && { color: C.scan }]}>التحكم السري</Text></Pressable>
            <Pressable style={[s.segBtn, mode === "random" && s.segOn]} onPress={() => setMode("random")}><Text style={[s.segTxt, mode === "random" && { color: C.scan }]}>عشوائي دائماً</Text></Pressable>
          </View>
          <Pressable style={[s.segBtn, flashOn && s.segOn]} onPress={toggleFlash}>
            <Text style={[s.segTxt, flashOn && { color: C.scan }]}>{flashOn ? "الفلاش أثناء الفحص: مفعّل" : "الفلاش أثناء الفحص: متوقف"}</Text>
          </Pressable>
          <Text style={s.mono}>النتيجة القادمة: {nextLabel}</Text>
          <Pressable style={s.segBtn} onPress={() => setPanel(false)}><Text style={s.segTxt}>إخفاء اللوحة</Text></Pressable>
        </View>
      )}
    </Animated.View>
  );
}

const mono = Platform.select({ ios: "Menlo", default: "monospace" });
const s = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1, paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  logo: { color: C.fg, fontSize: 20, fontWeight: "800" },
  status: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.dim },
  statusTxt: { color: C.dim, fontFamily: mono, fontSize: 12 },
  mono: { color: C.dim, fontFamily: mono, fontSize: 11, textAlign: "center" },
  monitor: { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 10, padding: 10, gap: 8 },
  monitorTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  bpm: { color: C.scan, fontFamily: mono, fontSize: 24, fontVariant: ["tabular-nums"] },
  wave: { height: 80, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  bar: { width: 3, borderRadius: 2, backgroundColor: C.scan },
  stage: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14 },
  hint: { color: C.dim, fontSize: 16, textAlign: "center", paddingHorizontal: 12 },
  padWrap: { width: 240, height: 240, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", width: 240, height: 240, borderRadius: 120, borderWidth: 3, borderColor: C.scan },
  pad: { width: 240, height: 240, borderRadius: 120, backgroundColor: "#0c1d17", borderWidth: 2, borderColor: C.line, alignItems: "center", justifyContent: "center" },
  padOn: { borderColor: C.scan },
  print: { position: "absolute", borderRadius: 999, borderWidth: 2 },
  progress: { width: 240, height: 6, backgroundColor: C.line, borderRadius: 3, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: C.scan },
  result: { minHeight: 96, alignItems: "center", justifyContent: "center" },
  word: { fontSize: 64, fontWeight: "800" },
  disclaimer: { color: C.dim, fontSize: 11, textAlign: "center" },
  zone: { position: "absolute", bottom: 0, width: 110, height: 130 },
  cam: { position: "absolute", width: 1, height: 1, opacity: 0, top: 0, left: 0 },
  panel: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "#0b1512", borderTopColor: C.line, borderTopWidth: 1, padding: 16, paddingBottom: 32, gap: 12 },
  panelTitle: { color: C.fg, fontSize: 18, fontWeight: "800", textAlign: "right" },
  panelTxt: { color: C.dim, fontSize: 14, lineHeight: 22, textAlign: "right" },
  seg: { flexDirection: "row", gap: 8 },
  segBtn: { flex: 1, backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 8, padding: 12, alignItems: "center" },
  segOn: { borderColor: C.scan },
  segTxt: { color: C.fg, fontWeight: "600", fontSize: 14 },
});
