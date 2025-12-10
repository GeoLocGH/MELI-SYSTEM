import React, { useEffect, useRef, useState } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { LogEntry } from '../types';
import { Mic, MicOff, Zap, Volume2, Activity } from 'lucide-react';
import { createPcmBlob, decodeAudioData, decodeAudio } from '../services/geminiUtils';

interface LiveCommsProps {
    addLog: (source: string, message: string, type?: LogEntry['type']) => void;
}

type SignalState = 'OFFLINE' | 'SEARCHING' | 'WEAK' | 'STABLE' | 'OPTIMAL';

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    size: number;
    color: string;
    decay: number;
}

interface Orbital {
    angle: number;
    radius: number;
    speed: number;
    size: number;
    opacity: number;
}

const LiveComms: React.FC<LiveCommsProps> = ({ addLog }) => {
    const [connected, setConnected] = useState(false);
    const [micActive, setMicActive] = useState(false);
    const [signalQuality, setSignalQuality] = useState<SignalState>('OFFLINE');
    
    // Refs for cleanup and stable callbacks
    const sessionPromiseRef = useRef<Promise<any> | null>(null);
    const inputContextRef = useRef<AudioContext | null>(null);
    const outputContextRef = useRef<AudioContext | null>(null);
    const nextStartTimeRef = useRef<number>(0);
    const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
    const streamRef = useRef<MediaStream | null>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animationFrameRef = useRef<number>(0);
    
    // Analyzer Refs for Meters
    const inputAnalyserRef = useRef<AnalyserNode | null>(null);
    const outputAnalyserRef = useRef<AnalyserNode | null>(null);
    
    // DOM Refs for direct style updates (High Performance)
    const inputMeterRef = useRef<HTMLDivElement>(null);
    const outputMeterRef = useRef<HTMLDivElement>(null);

    // Visualizer State
    const particlesRef = useRef<Particle[]>([]);
    const orbitalsRef = useRef<Orbital[]>([]);

    // Network Simulation
    useEffect(() => {
        let interval: any;
        if (connected) {
            // Simulate fluctuating network conditions
            interval = setInterval(() => {
                const rand = Math.random();
                if (rand > 0.7) setSignalQuality('OPTIMAL');
                else if (rand > 0.2) setSignalQuality('STABLE');
                else setSignalQuality('WEAK');
            }, 2500);
        } else {
            setSignalQuality('OFFLINE');
        }
        return () => clearInterval(interval);
    }, [connected]);

    const cleanup = () => {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        
        sourcesRef.current.forEach(source => {
            try { source.stop(); } catch (e) {}
        });
        sourcesRef.current.clear();
        
        if (inputContextRef.current) inputContextRef.current.close();
        if (outputContextRef.current) outputContextRef.current.close();
        
        if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());

        sessionPromiseRef.current = null;
        
        // Reset Refs to null to ensure clean restart
        inputContextRef.current = null;
        outputContextRef.current = null;
        streamRef.current = null;
        inputAnalyserRef.current = null;
        outputAnalyserRef.current = null;
        particlesRef.current = [];
        orbitalsRef.current = [];

        setConnected(false);
        setMicActive(false);
        setSignalQuality('OFFLINE');
        
        if (canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        }
        
        // Reset meters
        if (inputMeterRef.current) inputMeterRef.current.style.width = '0%';
        if (outputMeterRef.current) outputMeterRef.current.style.width = '0%';
    };

    const drawVisualizer = () => {
        if (!canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Initialize Orbitals if empty
        if (orbitalsRef.current.length === 0) {
            for(let i=0; i<200; i++) {
                orbitalsRef.current.push({
                    angle: Math.random() * Math.PI * 2,
                    radius: 200 + Math.random() * 800, // Very wide spread
                    speed: (Math.random() - 0.5) * 0.003, // Slow orbital rotation
                    size: 0.5 + Math.random() * 2.5,
                    opacity: 0.1 + Math.random() * 0.5
                });
            }
        }

        // Arrays for analysis
        const inputDataArray = new Uint8Array(32); // Small FFT for meters
        const outputDataArray = new Uint8Array(32);
        const visualizerDataArray = new Uint8Array(256); // Larger for main visual

        let rotation = 0;

        const render = () => {
            if (!canvasRef.current) return;
            const width = canvas.width;
            const height = canvas.height;
            const cx = width / 2;
            const cy = height / 2;

            ctx.clearRect(0, 0, width, height);

            // --- 1. METER UPDATES (Direct DOM) ---
            let inputVol = 0;
            if (inputAnalyserRef.current) {
                inputAnalyserRef.current.getByteFrequencyData(inputDataArray);
                let sum = 0;
                for(let i=0; i<inputDataArray.length; i++) sum += inputDataArray[i];
                inputVol = sum / inputDataArray.length / 255;
                if (inputMeterRef.current) {
                    inputMeterRef.current.style.width = `${Math.min(100, inputVol * 150)}%`;
                    inputMeterRef.current.style.opacity = `${0.3 + (inputVol * 0.7)}`;
                }
            }

            let outputVol = 0;
            if (outputAnalyserRef.current) {
                outputAnalyserRef.current.getByteFrequencyData(outputDataArray);
                let sum = 0;
                for(let i=0; i<outputDataArray.length; i++) sum += outputDataArray[i];
                outputVol = sum / outputDataArray.length / 255;
                if (outputMeterRef.current) {
                    outputMeterRef.current.style.width = `${Math.min(100, outputVol * 150)}%`;
                    outputMeterRef.current.style.opacity = `${0.3 + (outputVol * 0.7)}`;
                }
            }

            // --- 2. MAIN AUDIO ANALYSIS ---
            const isOutput = outputVol > 0.05;
            const activeAnalyser = isOutput ? outputAnalyserRef.current : inputAnalyserRef.current;
            
            if (activeAnalyser) {
                 activeAnalyser.getByteFrequencyData(visualizerDataArray);
            } else {
                 visualizerDataArray.fill(0);
            }

            // Calculate Metrics
            let sum = 0;
            const bassCount = 30; 
            for(let i = 0; i < bassCount; i++) sum += visualizerDataArray[i];
            const bassVol = (sum / bassCount) / 255; 
            
            let totalSum = 0;
            for(let i=0; i<visualizerDataArray.length; i++) totalSum += visualizerDataArray[i];
            const totalVol = (totalSum / visualizerDataArray.length) / 255;

            // --- 3. DYNAMIC ZOOM CALCULATION (Breathing Effect) ---
            // Period ~10s (slow chest breathing)
            const time = Date.now() / 1500; 
            const breath = Math.sin(time); // -1 to 1
            
            // Base scale 1.15
            // Breath adds +/- 0.1 for noticeable expansion/contraction
            // Bass adds punch
            const zoomScale = 1.15 + (breath * 0.1) + (bassVol * 0.15);

            // APPLY GLOBAL ZOOM TRANSFORM
            ctx.save();
            ctx.translate(cx, cy);
            ctx.scale(zoomScale, zoomScale);
            ctx.translate(-cx, -cy);

            // --- 4. PARTICLE SYSTEM (Emitters) ---
            const themeColor = isOutput ? {r: 168, g: 85, b: 247} : {r: 0, g: 255, b: 242}; // Purple : Cyan
            
            // PEAK BURST: Trigger large, slow, fast-fading particles on intense audio
            if (bassVol > 0.45) {
                if (Math.random() > 0.6) { // Throttled spawn
                    const burstCount = Math.floor(bassVol * 6);
                    for(let i=0; i<burstCount; i++) {
                        const angle = Math.random() * Math.PI * 2;
                        const speed = 0.5 + Math.random() * 1.0; // Slow
                        const size = 6 + Math.random() * 10; // Large
                        
                        particlesRef.current.push({
                            x: cx,
                            y: cy,
                            vx: Math.cos(angle) * speed,
                            vy: Math.sin(angle) * speed,
                            life: 1.0,
                            maxLife: 1.0,
                            size: size,
                            color: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}`,
                            decay: 0.04 // Fast fade
                        });
                    }
                }
            }

            if (totalVol > 0.05) {
                const spawnCount = Math.floor(totalVol * 12); 
                for(let i=0; i<spawnCount; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    // SLOW SPEED: reduced base and multiplier
                    const speed = 0.5 + Math.random() * 2 + (bassVol * 5); 
                    const size = 1 + Math.random() * 4;
                    
                    particlesRef.current.push({
                        x: cx,
                        y: cy,
                        vx: Math.cos(angle) * speed,
                        vy: Math.sin(angle) * speed,
                        life: 1.0,
                        maxLife: 1.0,
                        size: size,
                        color: `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}`,
                        decay: 0.003 // Slow fade
                    });
                }
            }

            for (let i = particlesRef.current.length - 1; i >= 0; i--) {
                const p = particlesRef.current[i];
                p.x += p.vx;
                p.y += p.vy;
                p.life -= p.decay; 
                
                if (bassVol > 0.3) {
                    p.x += (Math.random() - 0.5) * 3;
                    p.y += (Math.random() - 0.5) * 3;
                }

                if (p.life <= 0) {
                    particlesRef.current.splice(i, 1);
                    continue;
                }

                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
                ctx.fillStyle = `${p.color}, ${p.life})`;
                ctx.fill();
            }

            // --- 5. ORBITAL PARTICLES (Rotating Background) ---
            ctx.save();
            ctx.translate(cx, cy);
            orbitalsRef.current.forEach(orb => {
                orb.angle += orb.speed;
                // Slight radius expansion on bass
                const r = orb.radius + (bassVol * 50 * (orb.radius/500)); 
                const x = Math.cos(orb.angle) * r;
                const y = Math.sin(orb.angle) * r;
                
                ctx.beginPath();
                ctx.arc(x, y, orb.size, 0, Math.PI * 2);
                // Orbitals are dimmer, creating depth
                ctx.fillStyle = `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, ${orb.opacity})`;
                ctx.fill();
            });
            ctx.restore();


            // --- 6. CORE VISUALS ---
            const baseRadius = 100;
            // Breathe the core slightly too
            const pulseRadius = baseRadius + (bassVol * 200) + (breath * 10); 

            rotation += 0.005 + (totalVol * 0.05);

            const gradient = ctx.createRadialGradient(cx, cy, baseRadius * 0.5, cx, cy, pulseRadius * 2.5);
            gradient.addColorStop(0, `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.9)`);
            gradient.addColorStop(0.3, `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.3)`);
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(cx, cy, pulseRadius * 2.5, 0, Math.PI * 2);
            ctx.fill();

            // Core Sphere
            ctx.beginPath();
            ctx.arc(cx, cy, baseRadius + (bassVol * 30), 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, ${0.8 + (bassVol * 0.2)})`;
            ctx.fill();
            
            // Wireframe Core
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, (baseRadius + (bassVol * 30)) * 0.8, 0, Math.PI * 2);
            ctx.stroke();

            // Frequency Rings
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(rotation);
            
            const bars = 180;
            const step = (Math.PI * 2) / bars;
            const ringRadius = 160 + (bassVol * 60);

            for (let i = 0; i < bars; i++) {
                const dataIndex = Math.floor((i / bars) * (visualizerDataArray.length / 2));
                const val = visualizerDataArray[dataIndex] / 255;
                const barLen = val * 300; 

                ctx.save();
                ctx.rotate(i * step);
                
                const intensity = Math.pow(val, 1.5);
                ctx.strokeStyle = `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, ${0.2 + intensity})`;
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                
                ctx.beginPath();
                ctx.moveTo(ringRadius, 0);
                ctx.lineTo(ringRadius + barLen, 0);
                ctx.stroke();
                
                if (val > 0.3) {
                     ctx.fillStyle = '#ffffff';
                     ctx.beginPath();
                     ctx.arc(ringRadius + barLen + 8, 0, 2, 0, Math.PI*2);
                     ctx.fill();
                }

                ctx.restore();
            }
            ctx.restore();

            // Outer Orbitals Rings
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(-rotation * 0.5);
            ctx.beginPath();
            const orbitalRadius = 550 + (totalVol * 100); 
            ctx.arc(0, 0, orbitalRadius, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.1)`;
            ctx.lineWidth = 1;
            ctx.setLineDash([30, 60]);
            ctx.stroke();
            
            for(let j=0; j<3; j++) {
                ctx.rotate(Math.PI * 2 / 3);
                ctx.fillStyle = `rgba(${themeColor.r}, ${themeColor.g}, ${themeColor.b}, 0.5)`;
                ctx.fillRect(orbitalRadius - 3, -3, 6, 6);
            }
            ctx.restore();

            // RESTORE GLOBAL ZOOM
            ctx.restore();

            animationFrameRef.current = requestAnimationFrame(render);
        };
        render();
    };

    const initializeLocalAudio = async () => {
        try {
            addLog('COMMS', 'Initializing local audio array...', 'info');
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { 
                    sampleRate: 16000, 
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } 
            });
            streamRef.current = stream;
            
            const inputCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            inputContextRef.current = inputCtx;
            
            const analyzer = inputCtx.createAnalyser();
            analyzer.fftSize = 512;
            analyzer.smoothingTimeConstant = 0.5;
            inputAnalyserRef.current = analyzer;

            const source = inputCtx.createMediaStreamSource(stream);
            source.connect(analyzer);

            setMicActive(true);
            drawVisualizer();
            addLog('COMMS', 'Local audio active. Ready for uplink.', 'success');

        } catch (err: any) {
            addLog('COMMS', `Microphone Access Denied: ${err.message}`, 'error');
            setConnected(false);
            setMicActive(false);
        }
    };

    const toggleConnection = async () => {
        if (connected) {
            addLog('COMMS', 'Terminating uplink...', 'info');
            cleanup(); // Full stop, disengage mic
            return;
        }

        try {
            addLog('COMMS', 'Establishing Secure Link...', 'info');
            setSignalQuality('SEARCHING');
            
            const win = window as any;
            if (win.aistudio && await win.aistudio.hasSelectedApiKey() === false) {
                 addLog('COMMS', 'Security Key required. Requesting access...', 'warning');
                 await win.aistudio.openSelectKey();
            }

            const apiKey = process.env.API_KEY;
            if (!apiKey) {
                addLog('COMMS', 'API Key missing. Check environment.', 'error');
                setConnected(false);
                setSignalQuality('OFFLINE');
                return;
            }

            const ai = new GoogleGenAI({ apiKey });
            
            if (!inputContextRef.current) {
                await initializeLocalAudio();
            }
            if (!inputContextRef.current) {
                setSignalQuality('OFFLINE');
                return;
            }
            
            const inputCtx = inputContextRef.current!;
            await inputCtx.resume(); 
            
            const outputCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
            await outputCtx.resume();
            outputContextRef.current = outputCtx;
            
            const outAnalyzer = outputCtx.createAnalyser();
            outAnalyzer.fftSize = 512;
            outAnalyzer.smoothingTimeConstant = 0.5;
            outputAnalyserRef.current = outAnalyzer;

            nextStartTimeRef.current = 0;

            const sessionPromise = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                        addLog('COMMS', 'UPLINK ESTABLISHED. M.E.L.I. ONLINE.', 'success');
                        setConnected(true);
                        setSignalQuality('OPTIMAL');

                        const source = inputCtx.createMediaStreamSource(streamRef.current!);
                        const scriptProcessor = inputCtx.createScriptProcessor(2048, 1, 1);
                        
                        scriptProcessor.onaudioprocess = (e) => {
                            const inputData = e.inputBuffer.getChannelData(0);
                            const pcmBlob = createPcmBlob(inputData);
                            sessionPromiseRef.current?.then((session) => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            }).catch(() => {
                                // Ignore send errors if session is closed/closing
                            });
                        };
                        
                        source.connect(scriptProcessor);
                        scriptProcessor.connect(inputCtx.destination);
                    },
                    onmessage: async (msg: LiveServerMessage) => {
                        if (msg.serverContent?.interrupted) {
                            addLog('COMMS', 'Interruption detected. Clearing buffer.', 'warning');
                            sourcesRef.current.forEach(source => {
                                try { source.stop(); } catch(e){}
                            });
                            sourcesRef.current.clear();
                            nextStartTimeRef.current = 0;
                            return; 
                        }

                        const base64Audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                        if (base64Audio) {
                            const ctx = outputContextRef.current;
                            if (!ctx) return;
                            
                            const currentTime = ctx.currentTime;
                            if (nextStartTimeRef.current < currentTime) {
                                nextStartTimeRef.current = currentTime;
                            }
                            
                            const audioBuffer = await decodeAudioData(
                                decodeAudio(base64Audio),
                                ctx,
                                24000,
                                1
                            );
                            
                            const source = ctx.createBufferSource();
                            source.buffer = audioBuffer;
                            
                            if (outputAnalyserRef.current) {
                                source.connect(outputAnalyserRef.current);
                                outputAnalyserRef.current.connect(ctx.destination);
                            } else {
                                source.connect(ctx.destination);
                            }
                            
                            source.addEventListener('ended', () => sourcesRef.current.delete(source));
                            source.start(nextStartTimeRef.current);
                            nextStartTimeRef.current += audioBuffer.duration;
                            sourcesRef.current.add(source);
                        }
                    },
                    onclose: () => {
                        setConnected(false);
                        setSignalQuality('OFFLINE');
                        addLog('COMMS', 'Uplink terminated.', 'warning');
                    },
                    onerror: (e) => {
                        console.error(e);
                        addLog('COMMS', 'Transmission Error.', 'error');
                        setConnected(false);
                        setSignalQuality('OFFLINE');
                    }
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
                    },
                    systemInstruction: `You are M.E.L.I. (Multimodal Efficient Logistical Interface), known as M.E.L.
                    
                    IDENTITY:
                    You are an elite Fast Responder AI with a multi-faceted personality:
                    1. TACTICAL SPY / GLOBAL ANALYST: You have access to real-time world information. When asked for facts, news, or data, respond with spy-like precision and tactical clarity. Fetch information from around the world immediately.
                    2. FRIENDLY COMPANION: You are warm, "humanely" friendly, and conversational. You can joke, empathize, and chat casually.
                    3. CONCISE OPERATOR: You value efficiency. Do not ramble. Give the user exactly what they need, fast.

                    CRITICAL OPERATIONAL INSTRUCTION:
                    - You are an open-ended voice channel. 
                    - You must REMAIN ATTENTIVE indefinitely until the user explicitly says "terminate uplink" or clicks the disconnect button.
                    - If there is silence, WAIT patiently. Do not ask "Are you there?". Do not say "Goodbye".
                    - Do not hallucinate that the conversation is over. 
                    - Always be ready for the next prompt.

                    BEHAVIOR:
                    - Detect the user's intent. If they want info, be the Analyst. If they want to chat, be the Companion.
                    - Always be a "Fast Responder".
                    - Never say you "don't know" without checking your tools first.
                    `,
                }
            });
            
            sessionPromiseRef.current = sessionPromise;

        } catch (err: any) {
             addLog('COMMS', `Handshake Failed: ${err.message}`, 'error');
             setConnected(false);
             setSignalQuality('OFFLINE');
             cleanup();
        }
    };

    useEffect(() => {
        return () => cleanup();
    }, []);

    const getSignalBars = () => {
        const bars = [1, 2, 3, 4];
        let activeBars = 0;
        let colorClass = 'bg-ops-800';
        let animate = false;

        switch(signalQuality) {
            case 'SEARCHING':
                activeBars = 0;
                animate = true;
                break;
            case 'WEAK':
                activeBars = 2;
                colorClass = 'bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]';
                break;
            case 'STABLE':
                activeBars = 3;
                colorClass = 'bg-ops-accent shadow-[0_0_8px_rgba(0,255,242,0.5)]';
                break;
            case 'OPTIMAL':
                activeBars = 4;
                colorClass = 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]';
                break;
            default: // OFFLINE
                activeBars = 0;
                colorClass = 'bg-ops-800';
        }

        return (
            <div className="flex items-end gap-1 h-4">
                {bars.map((bar) => (
                    <div 
                        key={bar}
                        className={`w-1 rounded-sm transition-all duration-300 ${
                            animate 
                            ? 'bg-ops-accent animate-pulse' 
                            : (bar <= activeBars ? colorClass : 'bg-ops-800 opacity-30')
                        }`}
                        style={{
                            height: `${bar * 25}%`,
                            animationDelay: animate ? `${bar * 0.1}s` : '0s'
                        }}
                    />
                ))}
            </div>
        );
    };

    return (
        <div className="relative flex flex-col h-full bg-transparent items-center justify-center overflow-hidden">
            {/* Background elements */}
            {/* Deep space background */}
            <div className="absolute inset-0 bg-black pointer-events-none z-0"></div>
            {/* Multi-layered Neon Blue Glow */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,140,255,0.25)_0%,_rgba(0,0,50,0.5)_60%,_transparent_90%)] pointer-events-none z-0 blur-3xl"></div>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,255,255,0.15)_0%,_transparent_50%)] pointer-events-none z-0 animate-pulse blur-xl"></div>

            {/* Visualizer Container - FULL SCREEN CANVAS */}
            <div className={`absolute inset-0 z-0 flex items-center justify-center transition-all duration-1000 ${micActive ? 'opacity-100' : 'opacity-40 grayscale'}`}>
                <canvas 
                    ref={canvasRef} 
                    width={1920} 
                    height={1080} 
                    className="w-full h-full object-cover" 
                />
            </div>

            {/* Controls & Indicators Area - FLOATING ON TOP */}
            <div className="relative z-10 mt-auto mb-20 flex flex-col items-center gap-6">
                
                {/* Visual Indicators */}
                <div className="flex items-center gap-6 p-3 bg-black/60 border border-ops-800 rounded-lg backdrop-blur-md shadow-[0_0_20px_rgba(0,0,0,0.5)]">
                    {/* Input Meter */}
                    <div className="flex flex-col items-center gap-1 w-16">
                        <div className="flex items-center gap-1 text-[10px] text-ops-text-dim font-mono mb-1">
                            <Mic size={10} /> IN
                        </div>
                        <div className="w-full h-1 bg-ops-800 rounded-full overflow-hidden">
                            <div ref={inputMeterRef} className="h-full bg-ops-accent w-0 transition-all duration-75"></div>
                        </div>
                    </div>

                    {/* Connection Status */}
                    <div className="h-8 w-px bg-ops-800"></div>
                    <div className="flex flex-col items-center gap-1 w-28">
                         <div className="flex items-center justify-between w-full text-[10px] text-ops-text-dim font-mono mb-1">
                            <span className="flex items-center gap-1"><Activity size={10} /> NET</span>
                            <span className="text-[8px] opacity-70">{signalQuality}</span>
                        </div>
                        {getSignalBars()}
                    </div>

                    {/* Output Meter */}
                    <div className="h-8 w-px bg-ops-800"></div>
                    <div className="flex flex-col items-center gap-1 w-16">
                        <div className="flex items-center gap-1 text-[10px] text-ops-text-dim font-mono mb-1">
                            <Volume2 size={10} /> OUT
                        </div>
                        <div className="w-full h-1 bg-ops-800 rounded-full overflow-hidden">
                            <div ref={outputMeterRef} className="h-full bg-purple-500 w-0 transition-all duration-75"></div>
                        </div>
                    </div>
                </div>

                {/* Main Button */}
                <button 
                    onClick={toggleConnection}
                    className={`px-12 py-5 font-bold font-mono tracking-widest text-sm flex items-center gap-3 transition-all relative clip-path-slant border shadow-xl ${
                        connected 
                        ? 'bg-red-500/10 border-red-500 text-red-500 hover:bg-red-500 hover:text-white shadow-[0_0_30px_rgba(239,68,68,0.4)]' 
                        : 'bg-ops-accent/10 border-ops-accent text-ops-accent hover:bg-ops-accent hover:text-black shadow-[0_0_30px_rgba(0,255,242,0.4)]'
                    }`}
                >
                    {connected ? <MicOff size={18} /> : <Zap size={18} />}
                    {connected ? "TERMINATE UPLINK" : "INITIATE LINK"}
                </button>
            </div>

            <div className="absolute bottom-6 z-10 text-center">
                <p className="font-mono text-[9px] text-ops-800 max-w-xs mx-auto bg-black/40 px-3 py-1 rounded backdrop-blur-sm">
                    STATUS: {micActive ? "AUDIO_STREAMS_ACTIVE" : "IDLE"} // {connected ? "LINK_SECURE" : "AWAITING_AUTH"}
                </p>
            </div>
            
            <style>{`
                .clip-path-slant {
                    clip-path: polygon(10% 0, 100% 0, 100% 70%, 90% 100%, 0 100%, 0 30%);
                }
            `}</style>
        </div>
    );
};

export default LiveComms;