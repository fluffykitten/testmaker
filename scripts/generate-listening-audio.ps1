Add-Type -AssemblyName System.Speech

$dir = "e:/VibeCoding/testmaker/public/audio"
if (!(Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force
}

$outputPath = Join-Path $dir "pilot-english-listening.wav"
$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer

# Select Zira (female clear English) or David
try {
    $speak.SelectVoice("Microsoft Zira Desktop")
} catch {
    # Default voice
}

$speak.Rate = 0  # Normal conversational pace
$speak.Volume = 100

$speak.SetOutputToWaveFile($outputPath)

$text = "Attention students and invigilators. The annual Insan Cendekia Madani science and robotics exhibition will officially open in the secondary campus auditorium at 10:15 AM immediately following the morning assembly. Please ensure your project badges are clearly visible before entering the main hall."

$speak.Speak($text)
$speak.Dispose()

Write-Output "Successfully generated: $outputPath"
$file = Get-Item $outputPath
Write-Output "File size: $($file.Length) bytes"
