import { useCallback, useEffect, useRef, useState } from "react";
import { localNarrationVoices } from "./state";

/** Only voices the browser identifies as local are eligible; no remote provider. */
export function useLocalNarration(text: string) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const owned = useRef(false);
  const stop = useCallback(() => {
    generation.current++;
    if (owned.current && "speechSynthesis" in window)
      window.speechSynthesis.cancel();
    owned.current = false;
    setSpeaking(false);
  }, []);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const refresh = () => setVoices(localNarrationVoices(synth.getVoices()));
    refresh();
    synth.addEventListener("voiceschanged", refresh);
    return () => {
      synth.removeEventListener("voiceschanged", refresh);
      generation.current++;
      if (owned.current) synth.cancel();
      owned.current = false;
    };
  }, []);
  useEffect(() => {
    stop();
    setError("");
  }, [text, voiceURI, stop]);
  function start() {
    stop();
    const voice = voices.find((v) => v.voiceURI === voiceURI) ?? voices[0];
    if (!voice || !text.trim() || !("SpeechSynthesisUtterance" in window))
      return;
    const token = ++generation.current;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = 0.95;
      utterance.onend = () => {
        if (token === generation.current) {
          setSpeaking(false);
          owned.current = false;
        }
      };
      utterance.onerror = () => {
        if (token === generation.current) {
          setSpeaking(false);
          owned.current = false;
          setError(
            "Read-aloud stopped. The transcript is still available below.",
          );
        }
      };
      owned.current = true;
      setError("");
      setSpeaking(true);
      window.speechSynthesis.speak(utterance);
    } catch {
      owned.current = false;
      setSpeaking(false);
      setError(
        "Read-aloud is unavailable in this browser. Use the visible transcript.",
      );
    }
  }
  return {
    voices,
    voiceURI: voiceURI || voices[0]?.voiceURI || "",
    setVoiceURI,
    speaking,
    start,
    stop,
    error,
  };
}
