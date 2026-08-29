import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question, AudioMetadata } from '../types/database';
import {
  compressAudioInBrowser,
  uploadAudioToCloud,
  startVoiceRecording,
  getAvailableTtsVoices,
  speakTtsPreview,
  stopTtsSpeech,
  formatAudioDuration,
  fetchAudioLibraryTracks,
  type VoiceRecorderController,
  type TtsVoiceOption,
  type AudioLibraryItem,
} from '../services/audioService';
import { ExamAudioPlayer } from './ExamAudioPlayer';
import './BatchAudioModal.css';

export interface AudioSectionConfig {
  id: string;
  title: string;
  startQ: number;
  endQ: number;
  audioUrl: string;
  metadata: AudioMetadata;
}

interface BatchAudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  questions: Question[];
  onApplyAudioToRange: (updatedQuestions: Question[]) => void;
}

const SECTION_THEMES = [
  { bg: 'rgba(2, 132, 199, 0.12)', border: '#0284c7', text: '#0284c7', pill: '#e0f2fe' },
  { bg: 'rgba(16, 185, 129, 0.12)', border: '#10b981', text: '#059669', pill: '#d1fae5' },
  { bg: 'rgba(139, 92, 246, 0.12)', border: '#8b5cf6', text: '#7c3aed', pill: '#ede9fe' },
  { bg: 'rgba(245, 158, 11, 0.12)', border: '#f59e0b', text: '#d97706', pill: '#fef3c7' },
  { bg: 'rgba(244, 63, 94, 0.12)', border: '#f43f5e', text: '#e11d48', pill: '#ffe4e6' },
  { bg: 'rgba(6, 182, 212, 0.12)', border: '#06b6d4', text: '#0891b2', pill: '#cffafe' },
];

export function BatchAudioModal({
  isOpen,
  onClose,
  questions,
  onApplyAudioToRange,
}: BatchAudioModalProps) {
  const backdropDismiss = useBackdropDismiss(onClose);

  // Sections State (Multi-Track Timeline)
  const [sections, setSections] = useState<AudioSectionConfig[]>([]);
  const [activeSectionId, setActiveSectionId] = useState<string>('');

  // Creation Drawer State for Active Section
  const [activeDrawerTab, setActiveDrawerTab] = useState<'library' | 'upload' | 'record' | 'tts'>('library');

  // Voice recording state
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [recorderCtrl, setRecorderCtrl] = useState<VoiceRecorderController | null>(null);

  // TTS state
  const [ttsVoices, setTtsVoices] = useState<TtsVoiceOption[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('');
  const [ttsScript, setTtsScript] = useState<string>('');
  const [isSpeakingPreview, setIsSpeakingPreview] = useState<boolean>(false);

  // Library & Gallery State
  const [libraryTracks, setLibraryTracks] = useState<AudioLibraryItem[]>([]);
  const [librarySearch, setLibrarySearch] = useState<string>('');
  const [isLoadingLibrary, setIsLoadingLibrary] = useState<boolean>(false);

  // Upload / Processing state
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>('');

  // Load available TTS voices and library tracks on open
  useEffect(() => {
    if (isOpen) {
      getAvailableTtsVoices().then((voices) => {
        setTtsVoices(voices);
        if (voices.length > 0) setSelectedVoice(voices[0].name);
      });

      setIsLoadingLibrary(true);
      fetchAudioLibraryTracks()
        .then(setLibraryTracks)
        .finally(() => setIsLoadingLibrary(false));
    }
  }, [isOpen]);

  // Initialize sections from current test questions on open
  useEffect(() => {
    if (!isOpen || questions.length === 0) return;

    const initialSections: AudioSectionConfig[] = [];
    let currentSec: AudioSectionConfig | null = null;

    questions.forEach((q, idx) => {
      const qNum = idx + 1;
      if (q.audio_url) {
        if (currentSec && currentSec.audioUrl === q.audio_url) {
          currentSec.endQ = qNum;
        } else {
          if (currentSec) initialSections.push(currentSec);
          currentSec = {
            id: `sec-${Date.now()}-${initialSections.length + 1}`,
            title: q.audio_metadata?.title || `Section ${initialSections.length + 1}`,
            startQ: qNum,
            endQ: qNum,
            audioUrl: q.audio_url,
            metadata: {
              title: q.audio_metadata?.title || `Section ${initialSections.length + 1}`,
              duration: q.audio_metadata?.duration,
              transcript: q.audio_metadata?.transcript,
              play_limit: q.audio_metadata?.play_limit ?? 2,
              voice: q.audio_metadata?.voice,
            },
          };
        }
      } else {
        if (currentSec) {
          initialSections.push(currentSec);
          currentSec = null;
        }
      }
    });

    if (currentSec) initialSections.push(currentSec);

    // If test has no audio at all, create an initial Section 1 default
    if (initialSections.length === 0) {
      const defaultEnd = Math.min(questions.length, 10);
      initialSections.push({
        id: `sec-${Date.now()}-1`,
        title: 'Section 1: Listening Passage',
        startQ: 1,
        endQ: defaultEnd,
        audioUrl: '',
        metadata: {
          title: 'Section 1: Listening Passage',
          play_limit: 2,
        },
      });
    }

    setSections(initialSections);
    setActiveSectionId(initialSections[0]?.id || '');
  }, [isOpen, questions]);

  const activeSection = useMemo(() => {
    return sections.find((s) => s.id === activeSectionId) || sections[0] || null;
  }, [sections, activeSectionId]);

  // Section Manipulation Handlers
  const handleAddSection = () => {
    const lastSection = sections[sections.length - 1];
    let nextStart = 1;
    let nextEnd = Math.min(questions.length, 10);

    if (lastSection) {
      nextStart = Math.min(questions.length, lastSection.endQ + 1);
      nextEnd = Math.min(questions.length, nextStart + 9);
    }

    const newSec: AudioSectionConfig = {
      id: `sec-${Date.now()}-${sections.length + 1}`,
      title: `Section ${sections.length + 1}: Listening Dialogue`,
      startQ: nextStart,
      endQ: Math.max(nextStart, nextEnd),
      audioUrl: '',
      metadata: {
        title: `Section ${sections.length + 1}: Listening Dialogue`,
        play_limit: 2,
      },
    };

    setSections((prev) => [...prev, newSec]);
    setActiveSectionId(newSec.id);
  };

  const handleAutoDivideIelts = () => {
    const totalQ = questions.length;
    if (totalQ === 0) return;

    const quarter = Math.max(1, Math.floor(totalQ / 4));
    const newSections: AudioSectionConfig[] = [
      {
        id: `sec-${Date.now()}-1`,
        title: 'Section 1: Social Needs Dialogue (Form/Notes Completion)',
        startQ: 1,
        endQ: Math.min(totalQ, quarter),
        audioUrl: '',
        metadata: { title: 'Section 1: Social Needs Dialogue', play_limit: 2 },
      },
      {
        id: `sec-${Date.now()}-2`,
        title: 'Section 2: General Context Monologue (Map/Plan Labelling)',
        startQ: Math.min(totalQ, quarter + 1),
        endQ: Math.min(totalQ, quarter * 2),
        audioUrl: '',
        metadata: { title: 'Section 2: General Context Monologue', play_limit: 2 },
      },
      {
        id: `sec-${Date.now()}-3`,
        title: 'Section 3: Educational/Training Discussion (2-4 Speakers)',
        startQ: Math.min(totalQ, quarter * 2 + 1),
        endQ: Math.min(totalQ, quarter * 3),
        audioUrl: '',
        metadata: { title: 'Section 3: Educational Discussion', play_limit: 2 },
      },
      {
        id: `sec-${Date.now()}-4`,
        title: 'Section 4: Academic Monologue / Lecture',
        startQ: Math.min(totalQ, quarter * 3 + 1),
        endQ: totalQ,
        audioUrl: '',
        metadata: { title: 'Section 4: Academic Lecture', play_limit: 2 },
      },
    ].filter((s) => s.startQ <= totalQ);

    setSections(newSections);
    setActiveSectionId(newSections[0].id);
  };

  const handleRemoveSection = (id: string) => {
    const next = sections.filter((s) => s.id !== id);
    setSections(next);
    if (activeSectionId === id && next.length > 0) {
      setActiveSectionId(next[0].id);
    }
  };

  const handleUpdateActiveSection = (updates: Partial<AudioSectionConfig>) => {
    if (!activeSection) return;
    setSections((prev) =>
      prev.map((s) => (s.id === activeSection.id ? { ...s, ...updates } : s))
    );
  };

  const handleUpdateActiveMetadata = (updates: Partial<AudioMetadata>) => {
    if (!activeSection) return;
    setSections((prev) =>
      prev.map((s) =>
        s.id === activeSection.id
          ? { ...s, metadata: { ...s.metadata, ...updates } }
          : s
      )
    );
  };

  // 1. File Upload Handler for active section
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeSection) return;

    try {
      setIsProcessing(true);
      setStatusMsg('⚡ Compressing & optimizing audio (24kHz Mono Opus)...');

      const result = await compressAudioInBrowser(file);
      setStatusMsg('☁️ Uploading audio to cloud storage...');
      const publicUrl = await uploadAudioToCloud(result.blob, `track_${Date.now()}`);

      const finalUrl = publicUrl || URL.createObjectURL(result.blob);
      const title = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');

      handleUpdateActiveSection({
        audioUrl: finalUrl,
        title: activeSection.title || title,
        metadata: {
          ...activeSection.metadata,
          title: activeSection.title || title,
          duration: result.durationSeconds,
          original_size: result.originalSize,
          compressed_size: result.compressedSize,
        },
      });

      setStatusMsg('✓ Audio uploaded and attached to section!');
    } catch (err: any) {
      alert(`Audio upload failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
      setTimeout(() => setStatusMsg(''), 4000);
      e.target.value = '';
    }
  };

  // 2. Voice Recording for active section
  const handleStartRecording = async () => {
    try {
      const ctrl = await startVoiceRecording();
      setRecorderCtrl(ctrl);
      setIsRecording(true);
      setRecordingSeconds(0);
    } catch (err: any) {
      alert(`Microphone error: ${err?.message || 'Permission denied'}`);
    }
  };

  useEffect(() => {
    let timer: any;
    if (isRecording) {
      timer = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  const handleStopRecording = async () => {
    if (!recorderCtrl || !activeSection) return;
    try {
      setIsRecording(false);
      setIsProcessing(true);
      setStatusMsg('⚡ Optimizing voice recording...');

      const rawBlob = await recorderCtrl.stop();
      const result = await compressAudioInBrowser(rawBlob);

      setStatusMsg('☁️ Uploading recording...');
      const publicUrl = await uploadAudioToCloud(result.blob, `voice_${Date.now()}`);
      const finalUrl = publicUrl || URL.createObjectURL(result.blob);

      handleUpdateActiveSection({
        audioUrl: finalUrl,
        metadata: {
          ...activeSection.metadata,
          duration: result.durationSeconds,
          original_size: result.originalSize,
          compressed_size: result.compressedSize,
        },
      });
      setStatusMsg('✓ Voice recording attached to section!');
    } catch (err: any) {
      alert(`Recording error: ${err?.message || 'Failed to process'}`);
    } finally {
      setIsProcessing(false);
      setRecorderCtrl(null);
      setTimeout(() => setStatusMsg(''), 4000);
    }
  };

  // 3. TTS Speech Preview for active section
  const handleTtsPreview = () => {
    if (!ttsScript.trim()) return;
    if (isSpeakingPreview) {
      stopTtsSpeech();
      setIsSpeakingPreview(false);
    } else {
      setIsSpeakingPreview(true);
      speakTtsPreview(ttsScript, selectedVoice, 1.0, 1.0, () => {
        setIsSpeakingPreview(false);
      });
    }
  };

  const handleApplyTts = () => {
    if (!ttsScript.trim() || !activeSection) return;
    handleUpdateActiveMetadata({
      transcript: ttsScript.trim(),
      voice: selectedVoice,
    });
    setStatusMsg('✓ TTS script and voice profile assigned to section.');
    setTimeout(() => setStatusMsg(''), 3000);
  };

  // 4. Select Library Track for active section
  const handleSelectLibraryTrack = (track: AudioLibraryItem) => {
    if (!activeSection) return;
    handleUpdateActiveSection({
      audioUrl: track.url,
      title: activeSection.title.startsWith('Section') ? `${activeSection.title} - ${track.title}` : track.title,
      metadata: {
        ...activeSection.metadata,
        title: track.title,
        duration: track.duration,
        transcript: track.transcript,
        voice: track.voice,
        play_limit: track.play_limit ?? activeSection.metadata.play_limit,
      },
    });
    setStatusMsg(`✓ Attached "${track.title}" to ${activeSection.title}`);
    setTimeout(() => setStatusMsg(''), 3000);
  };

  // 5. Final Save & Apply All Sections across questions
  const handleApplyAllSections = () => {
    // Validate ranges
    const validSections = sections.filter((s) => s.audioUrl.trim().length > 0);
    if (validSections.length === 0) {
      alert('Please attach at least one audio track to a section before applying.');
      return;
    }

    const updated = questions.map((q, idx) => {
      const qNum = idx + 1;
      const sec = validSections.find((s) => qNum >= s.startQ && qNum <= s.endQ);
      if (sec) {
        return {
          ...q,
          audio_url: sec.audioUrl,
          audio_metadata: {
            ...sec.metadata,
            title: sec.title || `Listening Section (Q${sec.startQ}–Q${sec.endQ})`,
          },
        };
      }
      return {
        ...q,
        audio_url: null,
        audio_metadata: null,
      };
    });

    onApplyAudioToRange(updated);
    onClose();
  };

  const handleClearAllAudio = () => {
    if (confirm('Are you sure you want to remove all audio tracks from all questions in this test?')) {
      const updated = questions.map((q) => {
        const { audio_url: _a, audio_metadata: _m, ...rest } = q;
        return {
          ...rest,
          audio_url: null,
          audio_metadata: null,
        };
      });
      onApplyAudioToRange(updated);
      onClose();
    }
  };

  // Filter library tracks
  const filteredLibrary = useMemo(() => {
    if (!librarySearch.trim()) return libraryTracks;
    const q = librarySearch.trim().toLowerCase();
    return libraryTracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.transcript && t.transcript.toLowerCase().includes(q))
    );
  }, [libraryTracks, librarySearch]);

  if (!isOpen) return null;

  return createPortal(
    <div className="bam-backdrop animate-fade-in" {...backdropDismiss}>
      <div className="bam-modal bam-modal--multi animate-scale-up" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="bam-header">
          <div className="bam-title-group">
            <span className="bam-icon">🎧</span>
            <div>
              <h2 className="bam-title">Multi-Section Audio Timeline & Range Manager</h2>
              <p className="bam-sub">
                Configure multiple audio listening tracks for different question sections (IELTS & Cambridge 4-Section Listening format).
              </p>
            </div>
          </div>
          <button type="button" className="bam-close-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div className="bam-body">
          {/* Section 1: Visual Timeline Bar */}
          <div className="bam-timeline-card">
            <div className="bam-timeline-header">
              <span className="bam-timeline-title">📊 Exam Listening Coverage Timeline ({questions.length} Questions)</span>
              <div className="bam-quick-actions">
                <button
                  type="button"
                  className="bam-pill-btn"
                  onClick={handleAutoDivideIelts}
                  title="Automatically create 4 equal IELTS listening sections (e.g. Q1-10, Q11-20, Q21-30, Q31-40)"
                >
                  🪄 4 IELTS Sections
                </button>
                <button
                  type="button"
                  className="bam-pill-btn bam-pill-btn--add"
                  onClick={handleAddSection}
                  title="Add another audio section"
                >
                  + Add Section
                </button>
              </div>
            </div>

            {/* Segmented Timeline Meter */}
            <div className="bam-meter-track">
              {questions.map((_, idx) => {
                const qNum = idx + 1;
                const secIdx = sections.findIndex((s) => qNum >= s.startQ && qNum <= s.endQ);
                const sec = secIdx >= 0 ? sections[secIdx] : null;
                const theme = secIdx >= 0 ? SECTION_THEMES[secIdx % SECTION_THEMES.length] : null;
                const hasAudio = sec && Boolean(sec.audioUrl);

                return (
                  <div
                    key={qNum}
                    className={`bam-meter-slot ${sec ? 'bam-meter-slot--covered' : ''} ${hasAudio ? 'bam-meter-slot--ready' : ''} ${sec?.id === activeSectionId ? 'bam-meter-slot--active' : ''}`}
                    style={
                      sec && theme
                        ? {
                            backgroundColor: hasAudio ? theme.border : theme.bg,
                            color: hasAudio ? '#ffffff' : theme.text,
                            borderColor: theme.border,
                          }
                        : undefined
                    }
                    onClick={() => {
                      if (sec) setActiveSectionId(sec.id);
                    }}
                    title={`Q${qNum}: ${sec ? `${sec.title} (${hasAudio ? 'Audio Ready' : 'No Audio Selected'})` : 'No Audio'}`}
                  >
                    {qNum}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 2: Sections Navigation & Editor */}
          <div className="bam-sections-container">
            {/* Left Column: Sections List Tabs */}
            <div className="bam-sections-nav">
              <div className="bam-sections-nav-header">
                <span>Configured Sections ({sections.length})</span>
              </div>
              <div className="bam-sections-list">
                {sections.map((sec, idx) => {
                  const theme = SECTION_THEMES[idx % SECTION_THEMES.length];
                  const isActive = sec.id === activeSectionId;
                  const hasAudio = Boolean(sec.audioUrl);

                  return (
                    <div
                      key={sec.id}
                      className={`bam-section-tab ${isActive ? 'bam-section-tab--active' : ''}`}
                      style={{
                        borderLeftColor: theme.border,
                        background: isActive ? theme.bg : undefined,
                      }}
                      onClick={() => setActiveSectionId(sec.id)}
                    >
                      <div className="bam-sec-tab-top">
                        <span className="bam-sec-badge" style={{ backgroundColor: theme.pill, color: theme.text }}>
                          Q{sec.startQ}–Q{sec.endQ}
                        </span>
                        <span className={`bam-sec-status-dot ${hasAudio ? 'bam-sec-status-dot--ready' : ''}`} title={hasAudio ? 'Audio Track Ready' : 'Pending Audio Attachment'} />
                      </div>
                      <div className="bam-sec-tab-title">{sec.title || `Section ${idx + 1}`}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right Column: Active Section Editor Card */}
            {activeSection && (
              <div className="bam-section-editor animate-fade-in">
                {/* Active Section Header */}
                <div className="bam-sec-header-row">
                  <div style={{ flex: 1 }}>
                    <label className="bam-label">Section Title:</label>
                    <input
                      type="text"
                      className="bam-input"
                      value={activeSection.title}
                      onChange={(e) => handleUpdateActiveSection({ title: e.target.value })}
                      placeholder="e.g. Section 1: Hotel Booking Conversation"
                    />
                  </div>

                  <div className="bam-sec-range-group">
                    <div>
                      <label className="bam-label">Start Q:</label>
                      <input
                        type="number"
                        min={1}
                        max={questions.length}
                        className="bam-input bam-input--num"
                        value={activeSection.startQ}
                        onChange={(e) =>
                          handleUpdateActiveSection({
                            startQ: Math.max(1, Math.min(questions.length, parseInt(e.target.value, 10) || 1)),
                          })
                        }
                      />
                    </div>
                    <span className="bam-range-sep">to</span>
                    <div>
                      <label className="bam-label">End Q:</label>
                      <input
                        type="number"
                        min={activeSection.startQ}
                        max={questions.length}
                        className="bam-input bam-input--num"
                        value={activeSection.endQ}
                        onChange={(e) =>
                          handleUpdateActiveSection({
                            endQ: Math.max(activeSection.startQ, Math.min(questions.length, parseInt(e.target.value, 10) || activeSection.startQ)),
                          })
                        }
                      />
                    </div>
                  </div>

                  {sections.length > 1 && (
                    <button
                      type="button"
                      className="bam-delete-sec-btn"
                      onClick={() => handleRemoveSection(activeSection.id)}
                      title="Remove this audio section"
                    >
                      🗑️
                    </button>
                  )}
                </div>

                {/* Attached Audio Player Preview */}
                {activeSection.audioUrl ? (
                  <div className="bam-attached-preview-box animate-scale-up">
                    <div className="bam-attached-top-bar">
                      <span className="bam-attached-tag">🎵 Attached Listening Track</span>
                      <button
                        type="button"
                        className="bam-btn-sm-danger"
                        onClick={() => handleUpdateActiveSection({ audioUrl: '' })}
                      >
                        Change / Remove Track
                      </button>
                    </div>
                    <ExamAudioPlayer
                      audioUrl={activeSection.audioUrl}
                      metadata={activeSection.metadata}
                      questionRangeLabel={`Questions ${activeSection.startQ}–${activeSection.endQ}`}
                      allowTranscript={Boolean(activeSection.metadata.transcript)}
                    />
                    <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
                      <label style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--color-text-secondary)' }}>
                        Listening Play Limit:
                      </label>
                      <select
                        className="bam-select"
                        style={{ maxWidth: '200px', padding: '4px 8px', fontSize: '0.8125rem' }}
                        value={activeSection.metadata.play_limit === null ? 'unlimited' : activeSection.metadata.play_limit}
                        onChange={(e) =>
                          handleUpdateActiveMetadata({
                            play_limit: e.target.value === 'unlimited' ? null : parseInt(e.target.value, 10),
                          })
                        }
                      >
                        <option value="1">1 Play (Strict Exam)</option>
                        <option value="2">2 Plays (Standard Cambridge)</option>
                        <option value="3">3 Plays</option>
                        <option value="unlimited">Unlimited (Practice)</option>
                      </select>
                    </div>
                  </div>
                ) : (
                  /* Audio Selection Drawer for Active Section */
                  <div className="bam-track-picker-card">
                    <div className="bam-picker-tabs">
                      <button
                        type="button"
                        className={`bam-tab-btn ${activeDrawerTab === 'library' ? 'bam-tab-btn--active' : ''}`}
                        onClick={() => setActiveDrawerTab('library')}
                      >
                        📚 Audio Library ({libraryTracks.length})
                      </button>
                      <button
                        type="button"
                        className={`bam-tab-btn ${activeDrawerTab === 'upload' ? 'bam-tab-btn--active' : ''}`}
                        onClick={() => setActiveDrawerTab('upload')}
                      >
                        📁 Upload File
                      </button>
                      <button
                        type="button"
                        className={`bam-tab-btn ${activeDrawerTab === 'record' ? 'bam-tab-btn--active' : ''}`}
                        onClick={() => setActiveDrawerTab('record')}
                      >
                        🎙️ Record Voice
                      </button>
                      <button
                        type="button"
                        className={`bam-tab-btn ${activeDrawerTab === 'tts' ? 'bam-tab-btn--active' : ''}`}
                        onClick={() => setActiveDrawerTab('tts')}
                      >
                        🗣️ AI Speech
                      </button>
                    </div>

                    <div className="bam-drawer-body">
                      {/* TAB 1: Library */}
                      {activeDrawerTab === 'library' && (
                        <div className="bam-lib-pane">
                          <input
                            type="text"
                            className="bam-input"
                            placeholder="🔍 Search tracks by title, transcript or passage..."
                            value={librarySearch}
                            onChange={(e) => setLibrarySearch(e.target.value)}
                          />
                          <div className="bam-lib-scroll-list">
                            {isLoadingLibrary ? (
                              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                                ⏳ Loading audio library...
                              </div>
                            ) : filteredLibrary.length === 0 ? (
                              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                                No audio tracks found in library. Upload or record a track below!
                              </div>
                            ) : (
                              filteredLibrary.map((t, ti) => (
                                <div key={ti} className="bam-lib-card">
                                  <div style={{ flex: 1 }}>
                                    <div className="bam-lib-card-title">{t.title}</div>
                                    <div className="bam-lib-card-sub">
                                      {t.duration ? formatAudioDuration(t.duration) : 'Audio Track'} • {t.source === 'current_session' ? 'In Current Test' : 'From Cloud Library'}
                                    </div>
                                    {t.transcript && (
                                      <div className="bam-lib-card-snippet">"{t.transcript.slice(0, 100)}..."</div>
                                    )}
                                  </div>
                                  <button
                                    type="button"
                                    className="bam-select-track-btn"
                                    onClick={() => handleSelectLibraryTrack(t)}
                                  >
                                    Attach Track
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      )}

                      {/* TAB 2: Upload */}
                      {activeDrawerTab === 'upload' && (
                        <div className="bam-upload-dropzone">
                          <input
                            type="file"
                            accept="audio/*"
                            onChange={handleFileUpload}
                            style={{ display: 'none' }}
                            id="sec-audio-file-input"
                          />
                          <label htmlFor="sec-audio-file-input" className="bam-upload-btn-label">
                            📁 Select MP3 / WAV / M4A Audio File
                          </label>
                          <p style={{ margin: '8px 0 0', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                            High-quality Opus compression & cloud upload applied automatically.
                          </p>
                        </div>
                      )}

                      {/* TAB 3: Record */}
                      {activeDrawerTab === 'record' && (
                        <div className="bam-record-pane">
                          {!isRecording ? (
                            <button type="button" className="bam-btn-record" onClick={handleStartRecording}>
                              🎙️ Start Recording Teacher Voice
                            </button>
                          ) : (
                            <div className="bam-recording-live">
                              <span className="bam-pulse-dot" />
                              <span>Recording: {formatAudioDuration(recordingSeconds)}</span>
                              <button type="button" className="bam-btn-stop" onClick={handleStopRecording}>
                                ⏹️ Stop & Attach
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 4: TTS */}
                      {activeDrawerTab === 'tts' && (
                        <div className="bam-tts-pane">
                          <textarea
                            className="bam-textarea"
                            rows={3}
                            placeholder="Enter dialogue script or listening passage for IELTS AI reader..."
                            value={ttsScript}
                            onChange={(e) => setTtsScript(e.target.value)}
                          />
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                            <select
                              className="bam-select"
                              value={selectedVoice}
                              onChange={(e) => setSelectedVoice(e.target.value)}
                            >
                              {ttsVoices.map((v) => (
                                <option key={v.name} value={v.name}>
                                  {v.name} ({v.lang})
                                </option>
                              ))}
                            </select>
                            <button type="button" className="bam-btn-secondary" onClick={handleTtsPreview}>
                              {isSpeakingPreview ? '⏹️ Stop' : '🔊 Preview'}
                            </button>
                            <button type="button" className="bam-btn-primary" onClick={handleApplyTts}>
                              Set Script
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Status Message Banner */}
          {statusMsg && <div className="bam-proc-banner animate-fade-in">{statusMsg}</div>}
        </div>

        {/* Modal Footer */}
        <div className="bam-footer">
          <button
            type="button"
            className="bam-btn-danger"
            onClick={handleClearAllAudio}
            title="Remove all audio tracks from all questions in this test"
          >
            🗑️ Clear All Audio
          </button>

          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="bam-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="bam-btn-primary"
              onClick={handleApplyAllSections}
              disabled={isProcessing}
            >
              🚀 Apply All ({sections.filter((s) => s.audioUrl).length}) Audio Sections
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
