import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question, Syllabus, QuestionStyle, QuestionDifficulty, SubQuestion } from '../types/database';
import { ExamMathText } from './ExamMathText';
import { updateQuestion, createQuestion, fetchSyllabuses } from '../services/questionBankService';
import { DiagramCropModal } from './DiagramCropModal';
import { uploadSingleDiagramBlob } from '../lib/diagramCropper';
import {
  compressAudioInBrowser,
  uploadAudioToCloud,
  startVoiceRecording,
  getAvailableTtsVoices,
  speakTtsPreview,
  stopTtsSpeech,
  formatBytes,
  formatAudioDuration,
  fetchAudioLibraryTracks,
  type VoiceRecorderController,
  type TtsVoiceOption,
  type AudioLibraryItem,
} from '../services/audioService';
import { ExamAudioPlayer } from './ExamAudioPlayer';
import { InlineGapText, hasInlineGaps } from './InlineGapText';
import './QuestionEditorModal.css';

interface QuestionEditorModalProps {
  isOpen: boolean;
  question: Question | null;
  syllabuses?: Syllabus[];
  onClose: () => void;
  onSave: (saved: Question) => void;
}

type EditorTab = 'stem' | 'subquestions' | 'audio' | 'markscheme' | 'meta';

const MATH_TOOLBAR_ITEMS = [
  { label: 'Fraction', insert: '\\frac{numerator}{denominator}', title: 'Fraction: \\frac{a}{b}' },
  { label: 'x²', insert: '^{2}', title: 'Superscript: ^{2}' },
  { label: 'x₂', insert: '_{2}', title: 'Subscript: _{2}' },
  { label: '√x', insert: '\\sqrt{x}', title: 'Square Root: \\sqrt{x}' },
  { label: '→', insert: '\\rightarrow ', title: 'Right Arrow (Chemical reaction): \\rightarrow' },
  { label: '⇌', insert: '\\rightleftharpoons ', title: 'Equilibrium Arrow: \\rightleftharpoons' },
  { label: '×', insert: '\\times ', title: 'Multiplication sign: \\times' },
  { label: '±', insert: '\\pm ', title: 'Plus-minus: \\pm' },
  { label: '≤', insert: '\\le ', title: 'Less than or equal: \\le' },
  { label: '≥', insert: '\\ge ', title: 'Greater than or equal: \\ge' },
  { label: '°C', insert: '^\\circ\\text{C}', title: 'Degrees Celsius: ^\\circ\\text{C}' },
  { label: 'dm³', insert: '\\text{ dm}^3', title: 'Cubic decimeters: \\text{ dm}^3' },
  { label: 'cm³', insert: '\\text{ cm}^3', title: 'Cubic centimeters: \\text{ cm}^3' },
  { label: 'Δ (Delta)', insert: '\\Delta ', title: 'Delta: \\Delta' },
  { label: '✍️ Gap [1]', insert: ' [1] ', title: 'Insert Inline Blank Gap [1]' },
  { label: '📊 Table', insert: '\n\n| Item | Value | Unit |\n|---|---|---|\n| Substance A | 25.0 | $g$ |\n| Substance B | 100 | $cm^3$ |\n\n', title: 'Insert Markdown Table' },
];

export function QuestionEditorModal({
  isOpen,
  question,
  syllabuses: propSyllabuses,
  onClose,
  onSave,
}: QuestionEditorModalProps) {
  const isCreate = !question?.id;
  const [activeTab, setActiveTab] = useState<EditorTab>('stem');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [localSyllabuses, setLocalSyllabuses] = useState<Syllabus[]>(propSyllabuses || []);

  useEffect(() => {
    if (propSyllabuses && propSyllabuses.length > 0) {
      setLocalSyllabuses(propSyllabuses);
    } else if (isOpen) {
      fetchSyllabuses().then((res: Syllabus[]) => {
        if (res && res.length > 0) setLocalSyllabuses(res);
      }).catch(() => {});
    }
  }, [isOpen, propSyllabuses]);

  const syllabuses = localSyllabuses;

  // Form State
  const [syllabusId, setSyllabusId] = useState('');
  const [topic, setTopic] = useState('');
  const [subTopic, setSubTopic] = useState('');
  const [questionNumber, setQuestionNumber] = useState('1');
  const [year, setYear] = useState(new Date().getFullYear());
  const [series, setSeries] = useState('May/June');
  const [paperNumber, setPaperNumber] = useState<number | null>(41);
  const [questionStyle, setQuestionStyle] = useState<QuestionStyle>('Structured');
  const [difficulty, setDifficulty] = useState<QuestionDifficulty>('Medium');
  const [totalMarks, setTotalMarks] = useState(4);
  const [diagramUrl, setDiagramUrl] = useState('');
  const [questionText, setQuestionText] = useState('');

  // MCQ Options
  const [options, setOptions] = useState<string[]>([]);

  // Sub-Questions
  const [subQuestions, setSubQuestions] = useState<SubQuestion[]>([]);

  // Mark Scheme
  const [markingPoints, setMarkingPoints] = useState<string[]>(['']);
  const [acceptableAnswers, setAcceptableAnswers] = useState<string[]>([]);
  const [guidanceList, setGuidanceList] = useState<string[]>([]);
  const [misconceptionsList, setMisconceptionsList] = useState<string[]>([]);

  // Diagram Crop Modal state
  const [isCropModalOpen, setIsCropModalOpen] = useState(false);
  const [cropSourceFile, setCropSourceFile] = useState<File | null>(null);
  const [cropSourceImage, setCropSourceImage] = useState<string | null>(null);

  // Audio State & In-Browser Compression
  const [audioUrl, setAudioUrl] = useState('');
  const [audioTitle, setAudioTitle] = useState('');
  const [audioTranscript, setAudioTranscript] = useState('');
  const [audioPlayLimit, setAudioPlayLimit] = useState<number | null>(2);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [audioOriginalSize, setAudioOriginalSize] = useState<number | undefined>(undefined);
  const [audioCompressedSize, setAudioCompressedSize] = useState<number | undefined>(undefined);
  const [compressionRatioPercent, setCompressionRatioPercent] = useState<number | null>(null);
  const [isProcessingAudio, setIsProcessingAudio] = useState(false);
  const [audioProcessingStatus, setAudioProcessingStatus] = useState<string>('');

  // Audio Recording State
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recordingTimerRef = useRef<any>(null);
  const recorderControllerRef = useRef<VoiceRecorderController | null>(null);

  // TTS State
  const [ttsText, setTtsText] = useState('');
  const [selectedTtsVoice, setSelectedTtsVoice] = useState('');
  const [availableTtsVoices, setAvailableTtsVoices] = useState<TtsVoiceOption[]>([]);
  const [isTtsSpeaking, setIsTtsSpeaking] = useState(false);
  const [ttsRate, setTtsRate] = useState(0.95);

  // Audio Library State
  const [audioCreatorTab, setAudioCreatorTab] = useState<'library' | 'upload' | 'record' | 'tts'>('library');
  const [audioLibraryTracks, setAudioLibraryTracks] = useState<AudioLibraryItem[]>([]);
  const [audioLibrarySearch, setAudioLibrarySearch] = useState<string>('');
  const [isLoadingAudioLibrary, setIsLoadingAudioLibrary] = useState<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const backdropDismiss = useBackdropDismiss(onClose);

  // Load available TTS voices on mount
  useEffect(() => {
    getAvailableTtsVoices().then((voices) => {
      setAvailableTtsVoices(voices);
      if (voices.length > 0 && !selectedTtsVoice) {
        const engVoice = voices.find((v) => v.isEnglish) || voices[0];
        setSelectedTtsVoice(engVoice.name);
      }
    });
  }, [selectedTtsVoice]);

  // Load Audio Library Tracks when modal opens or audio tab is active
  useEffect(() => {
    if (isOpen && activeTab === 'audio') {
      setIsLoadingAudioLibrary(true);
      fetchAudioLibraryTracks()
        .then((tracks) => {
          setAudioLibraryTracks(tracks);
          if (tracks.length === 0 && !audioUrl) {
            setAudioCreatorTab('upload');
          }
        })
        .finally(() => setIsLoadingAudioLibrary(false));
    }
  }, [isOpen, activeTab, audioUrl]);

  // Initialize form whenever question changes or modal opens
  useEffect(() => {
    if (!isOpen) return;

    if (question) {
      const safeSyllabuses = Array.isArray(syllabuses) ? syllabuses : [];
      setSyllabusId(question.syllabus_id || (safeSyllabuses[0]?.id ?? ''));
      setTopic(question.topic || '');
      setSubTopic(question.sub_topic || '');
      setQuestionNumber(question.question_number || '1');
      setYear(Number(question.year) || new Date().getFullYear());
      setSeries(question.series || 'May/June');
      setPaperNumber(question.paper_number !== undefined && question.paper_number !== null ? Number(question.paper_number) : 41);
      setQuestionStyle(question.question_style || 'Structured');
      setDifficulty(question.difficulty || 'Medium');
      setTotalMarks(Number(question.marks) || 1);
      setDiagramUrl(question.diagram_url || '');
      setQuestionText(typeof question.question_text === 'string' ? question.question_text : (question.question_text ? JSON.stringify(question.question_text) : ''));

      // Safe MCQ options parsing
      if (Array.isArray(question.options)) {
        setOptions(question.options.map((opt) => typeof opt === 'string' ? opt : JSON.stringify(opt)));
      } else if (typeof question.options === 'string') {
        setOptions((question.options as string).split('\n').filter(Boolean));
      } else {
        setOptions([]);
      }

      // Sanitize sub-questions to ensure all fields are safe strings/numbers
      const rawSubs = Array.isArray(question.sub_questions) ? question.sub_questions : [];
      const sanitizedSubs: SubQuestion[] = rawSubs.map((sub: any) => ({
        sub_id: String(sub?.sub_id || ''),
        question_text: typeof sub?.question_text === 'string' ? sub.question_text : (sub?.question_text ? JSON.stringify(sub.question_text) : ''),
        marks: Number(sub?.marks) || 1,
        has_diagram: Boolean(sub?.diagram_url || sub?.has_diagram),
        diagram_url: sub?.diagram_url || null,
        diagram_source: sub?.diagram_source || null,
        resource_ref: sub?.resource_ref || null,
        page_number: sub?.page_number || null,
        insert_page_number: sub?.insert_page_number || null,
        bounding_box: sub?.bounding_box || null,
        audio_url: sub?.audio_url || null,
        audio_metadata: sub?.audio_metadata || null,
        options: Array.isArray(sub?.options) ? sub.options : null,
        mark_scheme: typeof sub?.mark_scheme === 'string'
          ? sub.mark_scheme
          : (sub?.mark_scheme?.marking_points
              ? (Array.isArray(sub.mark_scheme.marking_points) ? sub.mark_scheme.marking_points.join('; ') : String(sub.mark_scheme.marking_points))
              : (sub?.mark_scheme ? (typeof sub.mark_scheme === 'object' ? (sub.mark_scheme.answer || sub.mark_scheme.text || JSON.stringify(sub.mark_scheme)) : String(sub.mark_scheme)) : '')),
        guidance: typeof sub?.guidance === 'string'
          ? sub.guidance
          : (Array.isArray(sub?.guidance) ? sub.guidance.join('; ') : (sub?.guidance ? (typeof sub.guidance === 'object' ? JSON.stringify(sub.guidance) : String(sub.guidance)) : '')),
        common_misconceptions: Array.isArray(sub?.common_misconceptions)
          ? sub.common_misconceptions.map((m: any) => typeof m === 'string' ? m : String(m || ''))
          : (typeof sub?.common_misconceptions === 'string' ? [sub.common_misconceptions] : []),
      }));
      setSubQuestions(sanitizedSubs);

      // Safe Mark Scheme parsing
      let rawPoints: any[] = [];
      let rawAnswers: any[] = [];
      let rawGuidance: any[] = [];
      let rawMisconceptions: any[] = [];

      if (question.mark_scheme) {
        if (typeof question.mark_scheme === 'string') {
          rawPoints = [question.mark_scheme];
        } else if (typeof question.mark_scheme === 'object') {
          // Marking points
          if (Array.isArray(question.mark_scheme.marking_points)) {
            rawPoints = question.mark_scheme.marking_points;
          } else if (question.mark_scheme.marking_points) {
            rawPoints = [String(question.mark_scheme.marking_points)];
          } else if ((question.mark_scheme as any).points) {
            rawPoints = Array.isArray((question.mark_scheme as any).points)
              ? (question.mark_scheme as any).points
              : [String((question.mark_scheme as any).points)];
          } else if ((question.mark_scheme as any).answer) {
            rawPoints = [String((question.mark_scheme as any).answer)];
          }

          // Acceptable answers
          if (Array.isArray(question.mark_scheme.acceptable_answers)) {
            rawAnswers = question.mark_scheme.acceptable_answers;
          } else if (question.mark_scheme.acceptable_answers) {
            rawAnswers = [String(question.mark_scheme.acceptable_answers)];
          }

          // Guidance notes
          if (Array.isArray(question.mark_scheme.guidance)) {
            rawGuidance = question.mark_scheme.guidance;
          } else if (question.mark_scheme.guidance) {
            rawGuidance = [String(question.mark_scheme.guidance)];
          }

          // Misconceptions
          if (Array.isArray(question.mark_scheme.common_misconceptions)) {
            rawMisconceptions = question.mark_scheme.common_misconceptions;
          } else if (question.mark_scheme.common_misconceptions) {
            rawMisconceptions = [String(question.mark_scheme.common_misconceptions)];
          }
        }
      }

      const safePoints = rawPoints.map((p: any) =>
        typeof p === 'string' ? p : (typeof p === 'object' ? JSON.stringify(p) : String(p || ''))
      );
      setMarkingPoints(safePoints.length > 0 ? safePoints : ['']);
      setAcceptableAnswers(rawAnswers.map((a: any) => typeof a === 'string' ? a : String(a || '')));
      setGuidanceList(rawGuidance.map((g: any) => typeof g === 'string' ? g : String(g || '')));
      setMisconceptionsList(rawMisconceptions.map((m: any) => typeof m === 'string' ? m : String(m || '')));

      // Audio initialization
      setAudioUrl(question.audio_url || '');
      setAudioTitle(question.audio_metadata?.title || '');
      setAudioTranscript(question.audio_metadata?.transcript || '');
      setAudioPlayLimit(question.audio_metadata?.play_limit !== undefined ? question.audio_metadata.play_limit : 2);
      setAudioDuration(question.audio_metadata?.duration || 0);
      setAudioOriginalSize(question.audio_metadata?.original_size);
      setAudioCompressedSize(question.audio_metadata?.compressed_size);
      if (question.audio_metadata?.original_size && question.audio_metadata?.compressed_size) {
        const ratio = Math.round(((question.audio_metadata.original_size - question.audio_metadata.compressed_size) / question.audio_metadata.original_size) * 100);
        setCompressionRatioPercent(ratio);
      } else {
        setCompressionRatioPercent(null);
      }
      if (question.audio_metadata?.transcript) {
        setTtsText(question.audio_metadata.transcript);
      }
    } else {
      // Default blank question
      const safeSyllabuses = Array.isArray(syllabuses) ? syllabuses : [];
      setSyllabusId(safeSyllabuses[0]?.id ?? '');
      setTopic('General');
      setSubTopic('');
      setQuestionNumber('1');
      setYear(new Date().getFullYear());
      setSeries('May/June');
      setPaperNumber(41);
      setQuestionStyle('Multiple Choice');
      setDifficulty('Medium');
      setTotalMarks(1);
      setDiagramUrl('');
      setQuestionText('');
      setOptions(['', '', '', '']);
      setAudioUrl('');
      setAudioTitle('');
      setAudioTranscript('');
      setAudioPlayLimit(2);
      setAudioDuration(0);
      setAudioOriginalSize(undefined);
      setAudioCompressedSize(undefined);
      setCompressionRatioPercent(null);
      setSubQuestions([]);
      setMarkingPoints(['A']);
      setAcceptableAnswers([]);
      setGuidanceList([]);
      setMisconceptionsList([]);
    }
    setErrorMessage(null);
  }, [isOpen, question, syllabuses]);

  // Clean up any ongoing microphone recording or TTS speech on modal close / unmount
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      recorderControllerRef.current?.cancel();
      recorderControllerRef.current = null;
      stopTtsSpeech();
    };
  }, []);

  if (!isOpen) return null;

  // Insert token at cursor in questionText textarea
  const handleInsertMathToken = (token: string) => {
    if (!textareaRef.current) {
      setQuestionText((prev) => prev + token);
      return;
    }
    const elem = textareaRef.current;
    const start = elem.selectionStart;
    const end = elem.selectionEnd;
    const before = questionText.substring(0, start);
    const after = questionText.substring(end);

    setQuestionText(before + token + after);

    setTimeout(() => {
      elem.focus();
      elem.setSelectionRange(start + token.length, start + token.length);
    }, 50);
  };

  // Sub-question management
  const handleAddSubQuestion = () => {
    const nextIdx = subQuestions.length;
    const defaultLabels = ['(a)', '(b)', '(c)', '(d)', '(e)', '(f)', '(g)'];
    const label = defaultLabels[nextIdx] || `(${nextIdx + 1})`;

    setSubQuestions((prev) => [
      ...prev,
      {
        sub_id: label,
        question_text: '',
        marks: 1,
        mark_scheme: '',
      },
    ]);
  };

  const handleUpdateSubQuestion = (idx: number, updates: Partial<SubQuestion>) => {
    setSubQuestions((prev) =>
      prev.map((sub, i) => (i === idx ? { ...sub, ...updates } : sub))
    );
  };

  const handleRemoveSubQuestion = (idx: number) => {
    setSubQuestions((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleStyleChange = (newStyle: QuestionStyle) => {
    setQuestionStyle(newStyle);
    if (newStyle === 'Multiple Choice' || newStyle === 'Multiple Select') {
      setSubQuestions([]);
      if (options.length === 0) {
        setOptions(['', '', '', '']);
      }
      if (markingPoints.length === 0 || !markingPoints[0] || markingPoints[0].includes('sub-question')) {
        setMarkingPoints(['A']);
      }
    } else if (newStyle === 'Calculation' || newStyle === 'Short Answer') {
      setSubQuestions([]);
      setOptions([]);
    }
  };

  // Auto-calculate sub-question mark sum
  const subQuestionsTotalMarks = subQuestions.reduce((sum, s) => sum + (Number(s.marks) || 0), 0);

  // MCQ Options management
  const handleAddOption = () => {
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const nextLetter = letters[options.length] || String.fromCharCode(65 + options.length);
    setOptions((prev) => [...prev, `${nextLetter}. `]);
  };

  const handleUpdateOption = (idx: number, value: string) => {
    setOptions((prev) => prev.map((opt, i) => (i === idx ? value : opt)));
  };

  const handleRemoveOption = (idx: number) => {
    setOptions((prev) => prev.filter((_, i) => i !== idx));
  };

  // Mark scheme point management
  const handleAddMarkPoint = () => setMarkingPoints((prev) => [...prev, '']);
  const handleUpdateMarkPoint = (idx: number, val: string) =>
    setMarkingPoints((prev) => prev.map((p, i) => (i === idx ? val : p)));
  const handleRemoveMarkPoint = (idx: number) =>
    setMarkingPoints((prev) => prev.filter((_, i) => i !== idx));

  // Guidance management
  const handleAddGuidance = () => setGuidanceList((prev) => [...prev, '']);
  const handleUpdateGuidance = (idx: number, val: string) =>
    setGuidanceList((prev) => prev.map((g, i) => (i === idx ? val : g)));
  const handleRemoveGuidance = (idx: number) =>
    setGuidanceList((prev) => prev.filter((_, i) => i !== idx));

  // Misconceptions management
  const handleAddMisconception = () => setMisconceptionsList((prev) => [...prev, '']);
  const handleUpdateMisconception = (idx: number, val: string) =>
    setMisconceptionsList((prev) => prev.map((m, i) => (i === idx ? val : m)));
  const handleRemoveMisconception = (idx: number) =>
    setMisconceptionsList((prev) => prev.filter((_, i) => i !== idx));

  // ─── Audio Handlers ────────────────────────────────────────────────────────
  const handleAudioFileSelected = async (file: File) => {
    if (!file) return;

    if (file.size > 50 * 1024 * 1024) {
      setErrorMessage('Audio file size exceeds 50 MB safety ceiling. Please select a shorter audio file.');
      return;
    }

    setIsProcessingAudio(true);
    setErrorMessage(null);
    setAudioProcessingStatus(`⚡ Compressing audio with Web Audio API (Mono downmix & voice optimization)...`);

    try {
      // 1. In-browser client-side compression
      const comp = await compressAudioInBrowser(file);
      setAudioDuration(comp.durationSeconds);
      setAudioOriginalSize(comp.originalSize);
      setAudioCompressedSize(comp.compressedSize);
      const ratio = Math.round(comp.compressionRatio * 100);
      setCompressionRatioPercent(ratio);

      // 2. Direct upload to Supabase Storage
      setAudioProcessingStatus(`☁️ Uploading compact audio (${comp.formattedCompressedSize}) to cloud storage...`);
      const publicUrl = await uploadAudioToCloud(comp.blob, `q_${questionNumber || 'audio'}`);

      if (publicUrl) {
        setAudioUrl(publicUrl);
        if (!audioTitle) {
          const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
          setAudioTitle(cleanName);
        }
      } else {
        // Direct local blob preview fallback if storage is offline
        const localBlobUrl = URL.createObjectURL(comp.blob);
        setAudioUrl(localBlobUrl);
      }
    } catch (err: any) {
      setErrorMessage(`Audio compression error: ${err?.message || 'Failed to process audio'}`);
    } finally {
      setIsProcessingAudio(false);
      setAudioProcessingStatus('');
    }
  };

  const handleStartVoiceRecording = async () => {
    try {
      setErrorMessage(null);
      const controller = await startVoiceRecording();
      recorderControllerRef.current = controller;
      setIsRecordingVoice(true);
      setRecordingSeconds(0);

      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      setErrorMessage(`Microphone access error: ${err?.message || 'Please grant microphone permissions in your browser'}`);
    }
  };

  const handleStopVoiceRecording = async () => {
    if (!recorderControllerRef.current) return;
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    setIsRecordingVoice(false);
    setIsProcessingAudio(true);
    setAudioProcessingStatus('⚡ Processing & optimizing voice recording...');

    try {
      const rawBlob = await recorderControllerRef.current.stop();
      const comp = await compressAudioInBrowser(rawBlob);
      setAudioDuration(comp.durationSeconds);
      setAudioOriginalSize(comp.originalSize);
      setAudioCompressedSize(comp.compressedSize);
      setCompressionRatioPercent(Math.round(comp.compressionRatio * 100));

      setAudioProcessingStatus('☁️ Uploading recording to cloud storage...');
      const publicUrl = await uploadAudioToCloud(comp.blob, `voice_${Date.now()}`);
      if (publicUrl) {
        setAudioUrl(publicUrl);
        if (!audioTitle) setAudioTitle('Teacher Voice Prompt');
      } else {
        setAudioUrl(URL.createObjectURL(comp.blob));
      }
    } catch (err: any) {
      setErrorMessage(`Voice recording error: ${err?.message || 'Failed to process recording'}`);
    } finally {
      setIsProcessingAudio(false);
      setAudioProcessingStatus('');
      recorderControllerRef.current = null;
    }
  };

  const handleCancelVoiceRecording = () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recorderControllerRef.current?.cancel();
    recorderControllerRef.current = null;
    setIsRecordingVoice(false);
    setRecordingSeconds(0);
  };

  const handleTtsPreviewSpeak = () => {
    if (!ttsText.trim()) return;
    if (isTtsSpeaking) {
      stopTtsSpeech();
      setIsTtsSpeaking(false);
    } else {
      setIsTtsSpeaking(true);
      speakTtsPreview(ttsText, selectedTtsVoice, ttsRate, 1.0, () => {
        setIsTtsSpeaking(false);
      });
    }
  };

  const handleApplyTtsTranscript = () => {
    if (ttsText.trim()) {
      setAudioTranscript(ttsText.trim());
      if (!audioTitle) setAudioTitle('English Listening Passage');
    }
  };

  // Save handler
  const handleSave = async () => {
    if (!questionText.trim()) {
      setErrorMessage('Question text / stem cannot be empty.');
      setActiveTab('stem');
      return;
    }

    if (!topic.trim()) {
      setErrorMessage('Please provide a Topic name.');
      setActiveTab('meta');
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);

    const filteredMarkingPoints = markingPoints.filter((p) => p.trim().length > 0);
    const filteredGuidance = guidanceList.filter((g) => g.trim().length > 0);
    const filteredMisconceptions = misconceptionsList.filter((m) => m.trim().length > 0);

    const markSchemePayload = {
      marking_points: filteredMarkingPoints.length > 0 ? filteredMarkingPoints : ['See marking criteria'],
      acceptable_answers: acceptableAnswers.filter((a) => a.trim().length > 0),
      guidance: filteredGuidance.length > 0 ? filteredGuidance : undefined,
      common_misconceptions: filteredMisconceptions.length > 0 ? filteredMisconceptions : undefined,
    };

    const finalMarks =
      subQuestions.length > 0 && questionStyle === 'Structured'
        ? subQuestionsTotalMarks
        : totalMarks;

    const audioMetadataPayload = audioUrl.trim()
      ? {
          title: audioTitle.trim() || undefined,
          transcript: audioTranscript.trim() || undefined,
          duration: audioDuration || undefined,
          play_limit: audioPlayLimit,
          original_size: audioOriginalSize,
          compressed_size: audioCompressedSize,
        }
      : null;

    const isMcq = questionStyle === 'Multiple Choice' || questionStyle === 'Multiple Select';
    const cleanOptions = isMcq
      ? options.map((opt) => (typeof opt === 'string' ? opt.trim() : '')).filter(Boolean)
      : [];
    const finalSubQuestions = isMcq || questionStyle === 'Calculation' || questionStyle === 'Short Answer'
      ? []
      : subQuestions;

    const payload = {
      syllabus_id: syllabusId || (syllabuses[0]?.id ?? ''),
      year: Number(year) || new Date().getFullYear(),
      series: series || 'May/June',
      paper_number: paperNumber ? Number(paperNumber) : null,
      question_number: questionNumber || '1',
      parent_question_id: null,
      question_text: questionText,
      question_style: questionStyle,
      topic: topic.trim() || 'General',
      sub_topic: subTopic.trim() || null,
      difficulty: difficulty,
      marks: finalMarks,
      diagram_url: diagramUrl.trim() || null,
      audio_url: audioUrl.trim() || null,
      audio_metadata: audioMetadataPayload,
      options: cleanOptions.length > 0 ? cleanOptions : null,
      sub_questions: finalSubQuestions,
      mark_scheme: markSchemePayload,
    };

    try {
      const isDbRecord = question?.id && !question.id.startsWith('temp-') && !question.id.startsWith('local-');

      if (isDbRecord && question?.id) {
        // Update existing question in Supabase
        const updated = await updateQuestion(question.id, payload);
        if (updated) {
          onSave(updated);
          onClose();
        } else {
          // Fallback to local representation if DB write wasn't successful
          onSave({ ...question, ...payload, id: question.id });
          onClose();
        }
      } else if (question?.id) {
        // Transient question (e.g. from ExtractionReview)
        onSave({ ...question, ...payload, id: question.id });
        onClose();
      } else {
        // Create new custom question in Supabase
        const created = await createQuestion(payload as any);
        if (created) {
          onSave(created);
          onClose();
        } else {
          const fallbackLocal: Question = {
            id: `local-custom-${Date.now()}`,
            created_at: new Date().toISOString(),
            ...payload,
          };
          onSave(fallbackLocal);
          onClose();
        }
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to save question');
    } finally {
      setIsSaving(false);
    }
  };

  return createPortal(
    <div className="q-editor-backdrop animate-fade-in" {...backdropDismiss}>
      <div
        className="q-editor-card animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── Modal Header ───────────────────────────────────────────────── */}
        <div className="q-editor-header">
          <div className="q-editor-header-left">
            <span className="q-editor-icon">✏️</span>
            <div>
              <h2 className="q-editor-title">
                {isCreate ? 'Create Custom Question' : `Edit Question ${question?.question_number || ''}`}
              </h2>
              <p className="q-editor-subtitle">
                Author & customize questions with real-time KaTeX math formulas, sub-questions, and marking insights.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="q-editor-close-btn"
            onClick={onClose}
            aria-label="Close editor"
          >
            ✕
          </button>
        </div>

        {/* ─── Tabs Navigation ────────────────────────────────────────────── */}
        <div className="q-editor-tabs">
          <button
            type="button"
            className={`q-editor-tab-btn ${activeTab === 'stem' ? 'q-editor-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('stem')}
          >
            📝 Main Question Stem & Math
          </button>
          <button
            type="button"
            className={`q-editor-tab-btn ${activeTab === 'subquestions' ? 'q-editor-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('subquestions')}
          >
            🧩 Sub-Questions & Options
            {subQuestions.length > 0 && <span className="q-editor-tab-count">{subQuestions.length}</span>}
          </button>
          <button
            type="button"
            className={`q-editor-tab-btn ${activeTab === 'audio' ? 'q-editor-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('audio')}
          >
            🎧 Audio & Listening
            {audioUrl ? <span className="q-editor-tab-count" style={{ background: '#10b981' }}>✓</span> : null}
          </button>
          <button
            type="button"
            className={`q-editor-tab-btn ${activeTab === 'markscheme' ? 'q-editor-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('markscheme')}
          >
            ✨ Mark Scheme & Insights
          </button>
          <button
            type="button"
            className={`q-editor-tab-btn ${activeTab === 'meta' ? 'q-editor-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('meta')}
          >
            ⚙️ Topic & Exam Metadata
          </button>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div className="q-editor-error animate-fade-in">
            <span>⚠</span> {errorMessage}
          </div>
        )}

        {/* ─── Body Content ───────────────────────────────────────────────── */}
        <div className="q-editor-body">
          {/* TAB 1: Stem & Math */}
          {activeTab === 'stem' && (
            <div className="q-editor-tab-content animate-fade-in">
              {/* LaTeX Math & Chem Toolbar */}
              <div className="q-math-toolbar">
                <span className="q-toolbar-label">Quick Insert:</span>
                <div className="q-toolbar-chips">
                  {MATH_TOOLBAR_ITEMS.map((item, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="q-toolbar-btn"
                      onClick={() => handleInsertMathToken(item.insert)}
                      title={item.title}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Split Editor: Input on Left, Live KaTeX Preview on Right */}
              <div className="q-editor-split">
                <div className="q-editor-split-col">
                  <label className="q-editor-label" htmlFor="q-stem-input">
                    Question Stem Text (Supports LaTeX between <code>$...$</code> and Markdown tables):
                  </label>
                  <textarea
                    id="q-stem-input"
                    ref={textareaRef}
                    className="q-editor-textarea"
                    value={questionText}
                    onChange={(e) => setQuestionText(e.target.value)}
                    placeholder="Enter question text... (e.g. Calculate the mass of $CaCO_3$ required...)"
                    rows={8}
                  />
                </div>

                <div className="q-editor-split-col">
                  <span className="q-editor-label">
                    {questionStyle === 'Fill in the Blank' || hasInlineGaps(questionText)
                      ? '✍️ Interactive Gap Fill Preview:'
                      : 'Live Formatted Preview:'}
                  </span>
                  <div className="q-editor-preview-box">
                    {questionText.trim() ? (
                      questionStyle === 'Fill in the Blank' || hasInlineGaps(questionText) ? (
                        <InlineGapText content={questionText} isReadOnly={false} />
                      ) : (
                        <ExamMathText content={questionText} />
                      )
                    ) : (
                      <span className="q-editor-preview-placeholder">Live KaTeX math preview will render here...</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Diagram URL Input */}
              <div className="q-editor-field">
                <label className="q-editor-label" htmlFor="diagram-url-input">
                  Diagram / Visual Image (Optional URL, Image Upload, or Crop):
                </label>
                <div className="q-editor-url-row">
                  <input
                    type="url"
                    id="diagram-url-input"
                    className="q-editor-input"
                    value={diagramUrl}
                    onChange={(e) => setDiagramUrl(e.target.value)}
                    placeholder="https://..."
                  />

                  {/* Hidden file input for uploading images / PDFs to crop */}
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="image/*,application/pdf"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.type === 'application/pdf') {
                        setCropSourceFile(file);
                        setCropSourceImage(null);
                      } else {
                        const url = URL.createObjectURL(file);
                        setCropSourceImage(url);
                        setCropSourceFile(null);
                      }
                      setIsCropModalOpen(true);
                      e.target.value = '';
                    }}
                  />

                  <button
                    type="button"
                    className="q-editor-btn-secondary"
                    onClick={() => fileInputRef.current?.click()}
                    title="Upload an image or PDF to crop diagram region"
                  >
                    📁 Upload & Crop
                  </button>

                  {diagramUrl && (
                    <button
                      type="button"
                      className="q-editor-btn-secondary"
                      onClick={() => {
                        setCropSourceImage(diagramUrl);
                        setCropSourceFile(null);
                        setIsCropModalOpen(true);
                      }}
                      title="Adjust crop boundaries with 8-handle visual selector"
                    >
                      ✂️ Fine-Tune
                    </button>
                  )}

                  {diagramUrl && (
                    <button
                      type="button"
                      className="q-editor-btn-secondary"
                      onClick={() => setDiagramUrl('')}
                    >
                      Clear
                    </button>
                  )}
                </div>

                {diagramUrl && (
                  <div className="q-editor-diagram-preview">
                    <img src={diagramUrl} alt="Diagram preview" className="q-editor-diagram-thumb" />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: Sub-Questions & Options */}
          {activeTab === 'subquestions' && (
            <div className="q-editor-tab-content animate-fade-in">
              {/* Question Style Selection */}
              <div className="q-editor-style-picker">
                <label className="q-editor-label">Question Structure:</label>
                <div className="q-editor-style-radios">
                  {(['Structured', 'Multiple Choice', 'Multiple Select', 'Calculation', 'Short Answer', 'Fill in the Blank'] as QuestionStyle[]).map((style) => (
                    <label key={style} className={`q-style-radio ${questionStyle === style ? 'q-style-radio--active' : ''}`}>
                      <input
                        type="radio"
                        name="questionStyle"
                        value={style}
                        checked={questionStyle === style}
                        onChange={() => handleStyleChange(style)}
                      />
                      <span>{style}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Multiple Choice / Multiple Select Options Editor */}
              {(questionStyle === 'Multiple Choice' || questionStyle === 'Multiple Select') && (
                <div className="q-editor-options-section">
                  <div className="q-editor-subhead-row">
                    <h4 className="q-editor-subhead">Choices & Options ({options.length})</h4>
                    <button type="button" className="q-editor-btn-add" onClick={handleAddOption}>
                      + Add Choice
                    </button>
                  </div>

                  {options.length === 0 ? (
                    <div className="q-editor-empty-card">
                      <p>No options added yet.</p>
                      <button type="button" className="q-editor-btn-secondary" onClick={handleAddOption}>
                        + Add First Option (A)
                      </button>
                    </div>
                  ) : (
                    <div className="q-editor-options-list">
                      {options.map((opt, idx) => (
                        <div key={idx} className="q-editor-option-row">
                          <span className="q-editor-option-letter">{String.fromCharCode(65 + idx)}</span>
                          <input
                            type="text"
                            className="q-editor-input"
                            value={opt}
                            onChange={(e) => handleUpdateOption(idx, e.target.value)}
                            placeholder={`Option ${String.fromCharCode(65 + idx)} text`}
                          />
                          <button
                            type="button"
                            className="q-editor-btn-delete-small"
                            onClick={() => handleRemoveOption(idx)}
                            title="Delete this option"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Structured Sub-Questions Editor */}
              {questionStyle !== 'Multiple Choice' && questionStyle !== 'Multiple Select' && (
                <div className="q-editor-subs-section">
                  <div className="q-editor-subhead-row">
                    <div className="q-editor-subhead-left">
                      <button
                        type="button"
                        className="q-editor-btn-back-to-main"
                        onClick={() => setActiveTab('stem')}
                        title="Return to editing the main question stem & context"
                      >
                        ← Back to Main Question
                      </button>
                      <div>
                        <h4 className="q-editor-subhead">Sub-Questions / Multi-Part Breakdown ({subQuestions.length})</h4>
                        {subQuestions.length > 0 && (
                          <span className="q-subs-mark-total">
                            Sub-questions mark sum: <strong>{subQuestionsTotalMarks} marks</strong>
                          </span>
                        )}
                      </div>
                    </div>
                    <button type="button" className="q-editor-btn-add" onClick={handleAddSubQuestion}>
                      + Add Sub-Question Part
                    </button>
                  </div>

                  {subQuestions.length === 0 ? (
                    <div className="q-editor-empty-card">
                      <p>This is a single-part question without nested sub-parts.</p>
                      <button type="button" className="q-editor-btn-secondary" onClick={handleAddSubQuestion}>
                        Convert to Multi-Part Question (Add (a), (b)...)
                      </button>
                    </div>
                  ) : (
                    <div className="q-editor-subs-list">
                      {subQuestions.map((sub, si) => (
                        <div key={si} className="q-editor-sub-card">
                          <div className="q-editor-sub-header">
                            <input
                              type="text"
                              className="q-editor-sub-id-input"
                              value={sub.sub_id}
                              onChange={(e) => handleUpdateSubQuestion(si, { sub_id: e.target.value })}
                              placeholder="(a)"
                              title="Sub-question ID"
                            />
                            <div className="q-editor-sub-marks-wrap">
                              <label>Marks:</label>
                              <input
                                type="number"
                                min={1}
                                max={20}
                                className="q-editor-marks-input"
                                value={sub.marks}
                                onChange={(e) => handleUpdateSubQuestion(si, { marks: parseInt(e.target.value, 10) || 1 })}
                              />
                            </div>
                            <button
                              type="button"
                              className="q-editor-delete-btn"
                              onClick={() => handleRemoveSubQuestion(si)}
                              title="Remove sub-question"
                            >
                              ✕ Remove Part
                            </button>
                          </div>

                          <div className="q-editor-sub-body">
                            <div className="q-editor-sub-split">
                              {/* Left Edit Column */}
                              <div className="q-editor-sub-input-col">
                                <label className="q-editor-sub-label">Sub-part Question Text (LaTeX supported):</label>
                                <textarea
                                  className="q-editor-textarea q-editor-textarea--sm"
                                  value={sub.question_text}
                                  onChange={(e) => handleUpdateSubQuestion(si, { question_text: e.target.value })}
                                  placeholder="e.g. State the formula of hydrochloric acid..."
                                  rows={3}
                                />

                                <label className="q-editor-sub-label">Official Answer / Sub-Mark Scheme:</label>
                                <input
                                  type="text"
                                  className="q-editor-input"
                                  value={sub.mark_scheme || ''}
                                  onChange={(e) => handleUpdateSubQuestion(si, { mark_scheme: e.target.value })}
                                  placeholder="e.g. $HCl$ [1]"
                                />

                                <div className="q-editor-sub-insights-row">
                                  <div className="q-editor-sub-insight-field">
                                    <label className="q-editor-sub-label">💡 Examiner Tip (Optional):</label>
                                    <input
                                      type="text"
                                      className="q-editor-input q-editor-input--sm"
                                      value={sub.guidance || ''}
                                      onChange={(e) => handleUpdateSubQuestion(si, { guidance: e.target.value })}
                                      placeholder="e.g. Allow error carried forward (ecf) from part (a)"
                                    />
                                  </div>
                                </div>
                              </div>

                              {/* Right Live KaTeX Preview Column */}
                              <div className="q-editor-sub-preview-col">
                                <div className="q-editor-sub-preview-box">
                                  <div className="q-editor-sub-preview-top">
                                    <span className="q-editor-sub-preview-badge">
                                      {sub.sub_id ? sub.sub_id : `Part ${si + 1}`}
                                    </span>
                                    <span className="q-editor-sub-preview-marks">
                                      [{sub.marks || 1} mark{sub.marks !== 1 ? 's' : ''}]
                                    </span>
                                  </div>

                                  <div className="q-editor-sub-preview-text">
                                    {hasInlineGaps(sub.question_text) ? (
                                      <InlineGapText content={sub.question_text} isReadOnly={false} />
                                    ) : sub.question_text?.trim() ? (
                                      <ExamMathText content={sub.question_text} />
                                    ) : (
                                      <span className="q-editor-preview-placeholder">Live sub-part KaTeX preview will render here...</span>
                                    )}
                                  </div>

                                  {sub.mark_scheme && sub.mark_scheme.trim() && (
                                    <div className="q-editor-sub-preview-ans">
                                      <span className="q-editor-sub-preview-ans-label">Answer:</span>
                                      <ExamMathText content={sub.mark_scheme} />
                                    </div>
                                  )}

                                  {sub.guidance && sub.guidance.trim() && (
                                    <div className="q-editor-sub-preview-tip">
                                      <span>💡 {sub.guidance}</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: Mark Scheme & Insights */}
          {activeTab === 'markscheme' && (
            <div className="q-editor-tab-content animate-fade-in">
              {/* Marking Points */}
              <div className="q-editor-section">
                <div className="q-editor-subhead-row">
                  <h4 className="q-editor-subhead">Official Marking Points ({markingPoints.length})</h4>
                  <button type="button" className="q-editor-btn-add" onClick={handleAddMarkPoint}>
                    + Add Marking Point
                  </button>
                </div>

                <div className="q-editor-fields-list">
                  {markingPoints.map((point, pi) => (
                    <div key={pi} className="q-editor-field-row">
                      <span className="q-editor-row-num">{pi + 1}.</span>
                      <input
                        type="text"
                        className="q-editor-input"
                        value={point}
                        onChange={(e) => handleUpdateMarkPoint(pi, e.target.value)}
                        placeholder="e.g. Concentration decreases [1]; fewer successful collisions per second [1]"
                      />
                      {markingPoints.length > 1 && (
                        <button
                          type="button"
                          className="q-editor-delete-btn"
                          onClick={() => handleRemoveMarkPoint(pi)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Acceptable Answers */}
              <div className="q-editor-section">
                <div className="q-editor-subhead-row">
                  <h4 className="q-editor-subhead">Acceptable Alternative Answers</h4>
                  <button
                    type="button"
                    className="q-editor-btn-add"
                    onClick={() => setAcceptableAnswers((prev) => [...prev, ''])}
                  >
                    + Add Alternative
                  </button>
                </div>

                <div className="q-editor-fields-list">
                  {acceptableAnswers.map((ans, ai) => (
                    <div key={ai} className="q-editor-field-row">
                      <input
                        type="text"
                        className="q-editor-input"
                        value={ans}
                        onChange={(e) =>
                          setAcceptableAnswers((prev) => prev.map((a, i) => (i === ai ? e.target.value : a)))
                        }
                        placeholder="Alternative acceptable phrasing or value..."
                      />
                      <button
                        type="button"
                        className="q-editor-delete-btn"
                        onClick={() => setAcceptableAnswers((prev) => prev.filter((_, i) => i !== ai))}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Examiner Guidance */}
              <div className="q-editor-section">
                <div className="q-editor-subhead-row">
                  <h4 className="q-editor-subhead">💡 Examiner Marking Guidance & Tips</h4>
                  <button type="button" className="q-editor-btn-add" onClick={handleAddGuidance}>
                    + Add Guidance Note
                  </button>
                </div>

                <div className="q-editor-fields-list">
                  {guidanceList.map((g, gi) => (
                    <div key={gi} className="q-editor-field-row">
                      <input
                        type="text"
                        className="q-editor-input"
                        value={g}
                        onChange={(e) => handleUpdateGuidance(gi, e.target.value)}
                        placeholder="e.g. Award method mark (M1) for correct unit conversion even if final answer wrong."
                      />
                      <button
                        type="button"
                        className="q-editor-delete-btn"
                        onClick={() => handleRemoveGuidance(gi)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Common Misconceptions */}
              <div className="q-editor-section">
                <div className="q-editor-subhead-row">
                  <h4 className="q-editor-subhead">⚠️ Common Student Misconceptions</h4>
                  <button type="button" className="q-editor-btn-add" onClick={handleAddMisconception}>
                    + Add Misconception
                  </button>
                </div>

                <div className="q-editor-fields-list">
                  {misconceptionsList.map((m, mi) => (
                    <div key={mi} className="q-editor-field-row">
                      <input
                        type="text"
                        className="q-editor-input"
                        value={m}
                        onChange={(e) => handleUpdateMisconception(mi, e.target.value)}
                        placeholder="e.g. Students frequently forget to multiply by the molar volume 24 dm³."
                      />
                      <button
                        type="button"
                        className="q-editor-delete-btn"
                        onClick={() => handleRemoveMisconception(mi)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Audio & Listening Comprehension */}
          {activeTab === 'audio' && (
            <div className="q-editor-tab-content animate-fade-in">
              {/* Active Audio Preview */}
              {audioUrl ? (
                <div className="q-editor-section" style={{ background: 'rgba(99, 102, 241, 0.06)', border: '1.5px solid rgba(99, 102, 241, 0.3)', borderRadius: '14px', padding: '18px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '1.25rem' }}>🎧</span>
                      <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 800, color: 'var(--color-text-primary)' }}>
                        Attached Audio Track
                      </h4>
                    </div>
                    <button
                      type="button"
                      className="q-editor-delete-btn"
                      style={{ padding: '4px 10px', fontSize: '0.8125rem' }}
                      onClick={() => {
                        if (confirm('Remove audio track from this question?')) {
                          setAudioUrl('');
                          setAudioDuration(0);
                          setAudioOriginalSize(undefined);
                          setAudioCompressedSize(undefined);
                          setCompressionRatioPercent(null);
                        }
                      }}
                    >
                      ✕ Remove Audio
                    </button>
                  </div>

                  <ExamAudioPlayer
                    audioUrl={audioUrl}
                    metadata={{
                      title: audioTitle || 'English Listening Audio',
                      transcript: audioTranscript,
                      duration: audioDuration,
                      play_limit: audioPlayLimit,
                    }}
                    allowTranscript={Boolean(audioTranscript)}
                  />

                  {audioOriginalSize && audioCompressedSize && (
                    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8125rem', color: '#10b981', fontWeight: 700 }}>
                      {compressionRatioPercent !== null && compressionRatioPercent > 0 ? (
                        <>
                          <span>⚡ Client-Side Optimized:</span>
                          <span style={{ color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                            {formatBytes(audioOriginalSize)} → {formatBytes(audioCompressedSize)} ({compressionRatioPercent}% size saved, 24kHz Mono)
                          </span>
                        </>
                      ) : (
                        <>
                          <span>✓ File Ready:</span>
                          <span style={{ color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                            {formatBytes(audioOriginalSize)} (Already optimally compressed)
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ) : null}

              {/* Audio Processing Indicator */}
              {isProcessingAudio && (
                <div style={{ background: 'rgba(99, 102, 241, 0.12)', border: '1.5px solid #6366f1', borderRadius: '12px', padding: '16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }} className="animate-fade-in">
                  <div className="eap-spinner" style={{ width: 22, height: 22, border: '3px solid rgba(99, 102, 241, 0.3)', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--color-text-primary)' }}>Processing Audio...</div>
                    <div style={{ fontSize: '0.8125rem', color: '#a5b4fc' }}>{audioProcessingStatus}</div>
                  </div>
                </div>
              )}

              {/* Sub-Tabs for Audio Source */}
              <div style={{ display: 'flex', gap: 8, margin: '16px 0 12px', borderBottom: '1px solid var(--color-border)', paddingBottom: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`q-editor-btn-secondary ${audioCreatorTab === 'library' ? 'q-editor-btn-primary' : ''}`}
                  style={{ padding: '6px 14px', fontSize: '0.8125rem' }}
                  onClick={() => setAudioCreatorTab('library')}
                >
                  📚 Audio Library ({audioLibraryTracks.length})
                </button>
                <button
                  type="button"
                  className={`q-editor-btn-secondary ${audioCreatorTab === 'upload' ? 'q-editor-btn-primary' : ''}`}
                  style={{ padding: '6px 14px', fontSize: '0.8125rem' }}
                  onClick={() => setAudioCreatorTab('upload')}
                >
                  📁 Upload New File
                </button>
                <button
                  type="button"
                  className={`q-editor-btn-secondary ${audioCreatorTab === 'record' ? 'q-editor-btn-primary' : ''}`}
                  style={{ padding: '6px 14px', fontSize: '0.8125rem' }}
                  onClick={() => setAudioCreatorTab('record')}
                >
                  🎙️ Record Voice
                </button>
                <button
                  type="button"
                  className={`q-editor-btn-secondary ${audioCreatorTab === 'tts' ? 'q-editor-btn-primary' : ''}`}
                  style={{ padding: '6px 14px', fontSize: '0.8125rem' }}
                  onClick={() => setAudioCreatorTab('tts')}
                >
                  🗣️ Text-to-Speech (TTS)
                </button>
              </div>

              {/* TAB A: Audio Library Browser */}
              {audioCreatorTab === 'library' && (
                <div className="q-editor-section animate-fade-in" style={{ background: 'var(--color-surface-sunken)', padding: '16px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '1.25rem' }}>📚</span>
                      <h4 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 700 }}>Choose from Uploaded Audio Library</h4>
                    </div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                      Re-use existing audio tracks across questions
                    </span>
                  </div>

                  <input
                    type="text"
                    className="q-editor-input"
                    style={{ width: '100%', marginBottom: 12 }}
                    placeholder="🔍 Search tracks by title, topic, or keywords..."
                    value={audioLibrarySearch}
                    onChange={(e) => setAudioLibrarySearch(e.target.value)}
                  />

                  {isLoadingAudioLibrary ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                      <div className="eap-spinner" style={{ width: 20, height: 20, margin: '0 auto 8px', border: '2px solid rgba(99,102,241,0.3)', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                      <span>Loading library tracks...</span>
                    </div>
                  ) : audioLibraryTracks.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
                      <p style={{ margin: '0 0 10px' }}>No uploaded audio tracks found in library yet.</p>
                      <button
                        type="button"
                        className="q-editor-btn-secondary"
                        style={{ padding: '6px 14px' }}
                        onClick={() => setAudioCreatorTab('upload')}
                      >
                        📁 Upload First Audio Track
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '240px', overflowY: 'auto' }}>
                      {audioLibraryTracks
                        .filter((tr) => {
                          if (!audioLibrarySearch.trim()) return true;
                          const q = audioLibrarySearch.toLowerCase();
                          return tr.title.toLowerCase().includes(q) || (tr.transcript && tr.transcript.toLowerCase().includes(q));
                        })
                        .map((tr, idx) => (
                          <div
                            key={idx}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 12,
                              padding: '10px 14px',
                              background: audioUrl === tr.url ? 'rgba(99, 102, 241, 0.12)' : 'var(--color-surface)',
                              border: audioUrl === tr.url ? '1.5px solid var(--color-primary-500)' : '1px solid var(--color-border)',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              transition: 'all 0.15s',
                            }}
                            onClick={() => {
                              setAudioUrl(tr.url);
                              setAudioTitle(tr.title);
                              if (tr.duration) setAudioDuration(tr.duration);
                              if (tr.play_limit !== undefined) setAudioPlayLimit(tr.play_limit);
                              if (tr.transcript) setAudioTranscript(tr.transcript);
                            }}
                          >
                            <span style={{ fontSize: '1.25rem' }}>🎧</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {tr.title}
                              </div>
                              <div style={{ display: 'flex', gap: 8, fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                                {tr.duration ? <span>⏱️ {formatAudioDuration(tr.duration)}</span> : null}
                                {tr.source === 'cloud_storage' ? (
                                  <span style={{ color: '#a78bfa' }}>☁️ Cloud Storage</span>
                                ) : (
                                  <span style={{ color: '#34d399' }}>📚 Question Bank ({tr.usageCount || 1} Qs)</span>
                                )}
                              </div>
                            </div>
                            <button
                              type="button"
                              className={audioUrl === tr.url ? 'q-editor-btn-primary' : 'q-editor-btn-secondary'}
                              style={{ padding: '4px 12px', fontSize: '0.75rem' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setAudioUrl(tr.url);
                                setAudioTitle(tr.title);
                                if (tr.duration) setAudioDuration(tr.duration);
                                if (tr.play_limit !== undefined) setAudioPlayLimit(tr.play_limit);
                                if (tr.transcript) setAudioTranscript(tr.transcript);
                              }}
                            >
                              {audioUrl === tr.url ? '✓ Selected' : 'Select'}
                            </button>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {/* TAB B: File Upload */}
              {audioCreatorTab === 'upload' && (
                <div className="q-editor-section animate-fade-in" style={{ background: 'var(--color-surface-sunken)', padding: '18px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: '1.25rem' }}>📁</span>
                    <h4 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 700 }}>Upload New Audio File</h4>
                  </div>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
                    Upload any voice/dialogue recording (.mp3, .wav, .m4a, .ogg, .webm). Auto-compressed in-browser to save 80-95% space and saved to library!
                  </p>

                  <input
                    type="file"
                    ref={audioFileInputRef}
                    accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm,.aac"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleAudioFileSelected(file);
                      e.target.value = '';
                    }}
                  />

                  <button
                    type="button"
                    className="q-editor-btn-secondary"
                    style={{ width: '100%', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontWeight: 700 }}
                    onClick={() => audioFileInputRef.current?.click()}
                    disabled={isProcessingAudio}
                  >
                    <span>⬆ Choose Audio File to Upload</span>
                  </button>
                </div>
              )}

              {/* TAB C: Microphone Voice Recorder */}
              {audioCreatorTab === 'record' && (
                <div className="q-editor-section animate-fade-in" style={{ background: 'var(--color-surface-sunken)', padding: '18px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: '1.25rem' }}>🎙️</span>
                    <h4 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 700 }}>Record Voice with Microphone</h4>
                  </div>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
                    Record voice instructions or dialogue directly in TestMaker.
                  </p>

                  {isRecordingVoice ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.4)', padding: '8px 14px', borderRadius: '8px', color: '#fca5a5', fontWeight: 700 }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', animation: 'pulse 1s infinite' }} />
                        <span>Recording: {formatAudioDuration(recordingSeconds)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          type="button"
                          className="q-editor-btn-primary"
                          style={{ flex: 1, background: '#059669', padding: '8px 14px' }}
                          onClick={handleStopVoiceRecording}
                        >
                          ✓ Stop & Attach Audio
                        </button>
                        <button
                          type="button"
                          className="q-editor-delete-btn"
                          style={{ padding: '8px 14px' }}
                          onClick={handleCancelVoiceRecording}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="q-editor-btn-secondary"
                      style={{ width: '100%', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontWeight: 700 }}
                      onClick={handleStartVoiceRecording}
                      disabled={isProcessingAudio}
                    >
                      <span>🔴 Start Microphone Recording</span>
                    </button>
                  )}
                </div>
              )}

              {/* TAB D: Text-to-Speech (TTS) Studio */}
              {audioCreatorTab === 'tts' && (
                <div className="q-editor-section animate-fade-in" style={{ background: 'var(--color-surface-sunken)', padding: '18px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: '1.25rem' }}>🗣️</span>
                    <h4 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 700 }}>AI Text-to-Speech (TTS) Studio</h4>
                  </div>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', margin: '0 0 14px' }}>
                    Paste English dialogue text and test live speech playback with different accents (British UK, American US, Australian, etc.).
                  </p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <textarea
                      className="q-editor-textarea"
                      rows={3}
                      placeholder="Enter English listening dialogue or passage script to read aloud..."
                      value={ttsText}
                      onChange={(e) => setTtsText(e.target.value)}
                    />

                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>
                          Voice Accent:
                        </label>
                        <select
                          className="q-editor-select"
                          value={selectedTtsVoice}
                          onChange={(e) => setSelectedTtsVoice(e.target.value)}
                        >
                          {availableTtsVoices.map((v) => (
                            <option key={v.name} value={v.name}>
                              {v.displayName}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div style={{ width: 140 }}>
                        <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>
                          Speed: {ttsRate}x
                        </label>
                        <input
                          type="range"
                          min={0.75}
                          max={1.25}
                          step={0.05}
                          value={ttsRate}
                          onChange={(e) => setTtsRate(Number(e.target.value))}
                          style={{ width: '100%' }}
                        />
                      </div>

                      <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-end' }}>
                        <button
                          type="button"
                          className="q-editor-btn-secondary"
                          style={{ padding: '8px 14px', fontWeight: 700 }}
                          onClick={handleTtsPreviewSpeak}
                          disabled={!ttsText.trim()}
                        >
                          {isTtsSpeaking ? '⏹ Stop Speech' : '▶ Test Listen Voice'}
                        </button>

                        <button
                          type="button"
                          className="q-editor-btn-secondary"
                          style={{ padding: '8px 14px', fontWeight: 700 }}
                          onClick={handleApplyTtsTranscript}
                          disabled={!ttsText.trim()}
                          title="Copy script to audio transcript"
                        >
                          📝 Copy to Transcript
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Exam & Audio Settings */}
              <div className="q-editor-section" style={{ background: 'var(--color-surface-sunken)', padding: '18px', borderRadius: '12px', border: '1px solid var(--color-border)', marginTop: 16 }}>
                <h4 style={{ margin: '0 0 14px', fontSize: '0.9375rem', fontWeight: 700 }}>⚙️ Listening Exam Configuration</h4>

                <div className="q-editor-grid-2" style={{ gap: 14 }}>
                  <div className="q-editor-field">
                    <label className="q-editor-label" htmlFor="q-audio-title-input">
                      Audio Track Title / Description:
                    </label>
                    <input
                      type="text"
                      id="q-audio-title-input"
                      className="q-editor-input"
                      placeholder="e.g. Track 1: Conversation at the Airport"
                      value={audioTitle}
                      onChange={(e) => setAudioTitle(e.target.value)}
                    />
                  </div>

                  <div className="q-editor-field">
                    <label className="q-editor-label" htmlFor="q-audio-limit-select">
                      Exam Play Limit (Plays Allowed):
                    </label>
                    <select
                      id="q-audio-limit-select"
                      className="q-editor-select"
                      value={audioPlayLimit === null ? 'unlimited' : String(audioPlayLimit)}
                      onChange={(e) => {
                        const val = e.target.value;
                        setAudioPlayLimit(val === 'unlimited' ? null : Number(val));
                      }}
                    >
                      <option value="2">2 Times (Cambridge IGCSE / IELTS Listening Standard)</option>
                      <option value="1">1 Time (Strict Examination Standard)</option>
                      <option value="3">3 Times</option>
                      <option value="unlimited">Unlimited (Practice / Study Mode)</option>
                    </select>
                  </div>
                </div>

                <div className="q-editor-field" style={{ marginTop: 14 }}>
                  <label className="q-editor-label" htmlFor="q-audio-transcript-input">
                    Full Audio Transcript (For Teachers & Mark Schemes):
                  </label>
                  <textarea
                    id="q-audio-transcript-input"
                    className="q-editor-textarea"
                    rows={4}
                    placeholder="Enter complete text transcript of the recording (optional)..."
                    value={audioTranscript}
                    onChange={(e) => setAudioTranscript(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: Metadata & Provenance */}
          {activeTab === 'meta' && (
            <div className="q-editor-tab-content animate-fade-in">
              <div className="q-editor-grid-2">
                <div className="q-editor-field">
                  <label className="q-editor-label" htmlFor="q-syllabus-select">
                    Syllabus / Subject:
                  </label>
                  <select
                    id="q-syllabus-select"
                    className="q-editor-select"
                    value={syllabusId}
                    onChange={(e) => setSyllabusId(e.target.value)}
                  >
                    {Array.isArray(syllabuses) && syllabuses.length > 0 ? (
                      syllabuses.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.subject_name} ({s.subject_code})
                        </option>
                      ))
                    ) : (
                      <option value="">General / Default Syllabus</option>
                    )}
                  </select>
                </div>

                <div className="q-editor-field">
                  <label className="q-editor-label" htmlFor="q-topic-input">
                    Topic: *
                  </label>
                  <input
                    type="text"
                    id="q-topic-input"
                    className="q-editor-input"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="e.g. Stoichiometry, Organic Chemistry..."
                    required
                  />
                </div>

                <div className="q-editor-field">
                  <label className="q-editor-label" htmlFor="q-subtopic-input">
                    Sub-Topic (Optional):
                  </label>
                  <input
                    type="text"
                    id="q-subtopic-input"
                    className="q-editor-input"
                    value={subTopic}
                    onChange={(e) => setSubTopic(e.target.value)}
                    placeholder="e.g. Moles, Alkanes, Rates..."
                  />
                </div>

                <div className="q-editor-field">
                  <label className="q-editor-label" htmlFor="q-difficulty-select">
                    Difficulty Level:
                  </label>
                  <select
                    id="q-difficulty-select"
                    className="q-editor-select"
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value as QuestionDifficulty)}
                  >
                    <option value="Easy">Easy</option>
                    <option value="Medium">Medium</option>
                    <option value="Hard">Hard</option>
                  </select>
                </div>

                <div className="q-editor-field">
                  <label className="q-editor-label" htmlFor="q-marks-input">
                    Total Marks:
                  </label>
                  <input
                    type="number"
                    id="q-marks-input"
                    min={1}
                    max={100}
                    className="q-editor-input"
                    value={subQuestions.length > 0 && questionStyle === 'Structured' ? subQuestionsTotalMarks : totalMarks}
                    disabled={subQuestions.length > 0 && questionStyle === 'Structured'}
                    onChange={(e) => setTotalMarks(parseInt(e.target.value, 10) || 1)}
                  />
                  {subQuestions.length > 0 && questionStyle === 'Structured' && (
                    <span className="q-editor-hint">
                      Auto-calculated from sub-question parts ({subQuestionsTotalMarks} marks)
                    </span>
                  )}
                </div>

                <div className="q-editor-field">
                  <label className="q-editor-label" htmlFor="q-num-input">
                    Question Number / ID:
                  </label>
                  <input
                    type="text"
                    id="q-num-input"
                    className="q-editor-input"
                    value={questionNumber}
                    onChange={(e) => setQuestionNumber(e.target.value)}
                    placeholder="e.g. 1, 2(a), 4"
                  />
                </div>

                <div className="q-editor-field">
                  <label className="q-editor-label" htmlFor="q-year-input">
                    Exam Year:
                  </label>
                  <input
                    type="number"
                    id="q-year-input"
                    min={2000}
                    max={2030}
                    className="q-editor-input"
                    value={year}
                    onChange={(e) => setYear(parseInt(e.target.value, 10) || 2024)}
                  />
                </div>

                <div className="q-editor-field">
                  <label className="q-editor-label" htmlFor="q-series-input">
                    Exam Series:
                  </label>
                  <input
                    type="text"
                    id="q-series-input"
                    className="q-editor-input"
                    value={series}
                    onChange={(e) => setSeries(e.target.value)}
                    placeholder="e.g. May/June, Oct/Nov, Specimen"
                  />
                </div>

                <div className="q-editor-field">
                  <label className="q-editor-label" htmlFor="q-paper-input">
                    Paper Number:
                  </label>
                  <input
                    type="number"
                    id="q-paper-input"
                    className="q-editor-input"
                    value={paperNumber ?? ''}
                    onChange={(e) => setPaperNumber(e.target.value ? parseInt(e.target.value, 10) : null)}
                    placeholder="e.g. 1, 2, 4, 41, 62"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ─── Modal Footer ───────────────────────────────────────────────── */}
        <div className="q-editor-footer">
          <div className="q-editor-footer-left">
            <span className="q-editor-summary-pill">
              Total: {subQuestions.length > 0 && questionStyle === 'Structured' ? subQuestionsTotalMarks : totalMarks} Marks • {questionStyle}
            </span>
          </div>

          <div className="q-editor-footer-right">
            {activeTab === 'subquestions' && (
              <button
                type="button"
                className="q-editor-btn-secondary"
                onClick={() => setActiveTab('stem')}
                title="Return to editing the main question stem"
              >
                ← Main Question
              </button>
            )}
            <button
              type="button"
              className="q-editor-btn-secondary"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="q-editor-btn-primary"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? 'Saving Changes…' : isCreate ? 'Create & Add to Question Bank' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>

      {/* ─── Diagram Fine-Tuner Modal ─────────────────────────────────────── */}
      {isCropModalOpen && (
        <DiagramCropModal
          isOpen={true}
          pdfFile={cropSourceFile}
          imageSrc={cropSourceImage || diagramUrl || null}
          questionNumber={questionNumber}
          onClose={() => setIsCropModalOpen(false)}
          onSaveCrop={async ({ blob, localUrl }) => {
            setDiagramUrl(localUrl);
            setIsCropModalOpen(false);
            try {
              const uploadedUrl = await uploadSingleDiagramBlob(blob, {
                question_number: questionNumber || '1',
                year: Number(year) || new Date().getFullYear(),
                paper_number: paperNumber ? Number(paperNumber) : 1,
              });
              if (uploadedUrl) {
                setDiagramUrl(uploadedUrl);
              }
            } catch (err) {
              console.warn('Diagram upload note:', err);
            }
          }}
        />
      )}
    </div>,
    document.body
  );
}
