import { useRef, useState } from 'react';
import { isRecordingSupported, startRecording } from '../lib/voice';
import { ChatComposer, IconButton, Spinner, Icon, Mic, Square } from '../ui';

export default function Composer({ onSend, disabled, language, role }) {
  const [text, setText] = useState('');
  const [voiceState, setVoiceState] = useState('idle'); // idle | recording | transcribing
  const [voiceError, setVoiceError] = useState(null);
  const recRef = useRef(null);

  const submit = (value) => {
    const q = (value ?? text).trim();
    if (!q || disabled) return;
    onSend(q);
    setText('');
  };

  const toggleMic = async () => {
    if (voiceState === 'recording') { recRef.current?.stop(); return; }
    if (voiceState === 'transcribing') return;
    setVoiceError(null);
    try {
      recRef.current = await startRecording({
        language, role,
        onText: (nextText) => {
          if (nextText) setText((previous) => (previous ? previous + ' ' : '') + nextText);
        },
        onState: setVoiceState,
        onError: () => {
          setVoiceState('idle');
          setVoiceError('Voice input failed. Check microphone permission and try again.');
        },
      });
    } catch {
      setVoiceState('idle');
      setVoiceError('Microphone access was not available. You can continue by typing.');
    }
  };

  const micButton = isRecordingSupported() ? (
    voiceState === 'transcribing' ? (
      <IconButton icon={<Spinner size="sm" />} label="Transcribing" variant="ghost" isDisabled />
    ) : (
      <IconButton
        icon={<Icon icon={voiceState === 'recording' ? Square : Mic} size="sm" />}
        label={voiceState === 'recording' ? 'Stop & transcribe' : 'Voice input'}
        variant={voiceState === 'recording' ? 'destructive' : 'secondary'}
        onClick={toggleMic}
      />
    )
  ) : null;

  return (
    <ChatComposer
      value={text}
      onChange={setText}
      onSubmit={submit}
      isDisabled={disabled}
      sendActions={micButton}
      status={voiceError ? { type: 'error', message: voiceError } : undefined}
      placeholder={language === 'kn'
        ? 'ಅಪರಾಧ ದತ್ತಾಂಶವನ್ನು ಕೇಳಿ… (ಉದಾ: ಬೆಂಗಳೂರಿನಲ್ಲಿ ಕೊಲೆ ಪ್ರಕರಣಗಳು)'
        : 'Ask anything about the crime data…  (e.g. who is the top offender and their linked cases?)'}
    />
  );
}
