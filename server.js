// server.js
const express = require('express');
const cors = require('cors');
const { YoutubeTranscript } = require('youtube-transcript');
const axios = require('axios');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Initialize OpenAI API with your key
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware
const corsOptions = {
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// Extract video ID from YouTube URL
const extractVideoId = (url) => {
  const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[7].length === 11) ? match[7] : null;
};

// Extract chapters from video description
const extractChaptersFromDescription = (description) => {
  if (!description) return [];
  
  const timestampRegex = /([0-9]+:)?([0-9]+):([0-9]+)[ \t]+(.+)($|\n)/g;
  const matches = [...description.matchAll(timestampRegex)];
  
  if (matches.length === 0) return [];
  
  const chapters = matches.map(match => {
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    
    if (match[1]) { // If hours are present
      hours = parseInt(match[1].replace(':', ''), 10);
      minutes = parseInt(match[2], 10);
      seconds = parseInt(match[3], 10);
    } else {
      minutes = parseInt(match[2], 10);
      seconds = parseInt(match[3], 10);
    }
    
    const timeInSeconds = hours * 3600 + minutes * 60 + seconds;
    
    return {
      title: match[4].trim(),
      time: timeInSeconds,
      timeFormatted: match[0].split(' ')[0].trim()
    };
  });
  
  return chapters;
};

// Helper function to clean HTML entities from text
function cleanHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;#39;/g, "'");
}

// Helper function to organize transcript by chapters
function organizeTranscriptByChapters(transcriptData, chapters) {
  const segments = [];
  
  for (let i = 0; i < chapters.length; i++) {
    const currentChapter = chapters[i];
    const nextChapter = chapters[i + 1];
    
    const startTime = currentChapter.time;
    const endTime = nextChapter ? nextChapter.time : Infinity;
    
    const chapterTranscriptData = transcriptData.filter(item => {
      return item.offset >= startTime && item.offset < endTime;
    });
    
    const chapterContent = chapterTranscriptData
      .map(item => item.text)
      .join(' ')
      .replace(/\s+/g, ' ');
    
    segments.push({
      title: currentChapter.title,
      time: currentChapter.timeFormatted,
      content: chapterContent || 'No transcript available for this chapter'
    });
  }
  
  return segments;
}

// Helper function to extract brief summary from chapter analysis
const extractBriefSummary = (analysis) => {
  if (!analysis || !analysis.summary) return '';
  return analysis.summary;
};

// Endpoint to get video data and transcript
app.get('/api/video-data', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ message: 'Please provide a YouTube video URL' });
    }
    
    const videoId = extractVideoId(url);
    
    if (!videoId) {
      return res.status(400).json({ message: 'Invalid YouTube URL' });
    }
    
    console.log('Processing video ID:', videoId);
    
    // Fetch video details from YouTube API
    let videoDetails = null;
    let chapters = [];
    
    try {
      const detailsResponse = await axios.get(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${YOUTUBE_API_KEY}`
      );
      
      if (detailsResponse.data.items && detailsResponse.data.items.length > 0) {
        const item = detailsResponse.data.items[0];
        const snippet = item.snippet;
        const statistics = item.statistics;
        const contentDetails = item.contentDetails;
        
        let formattedDuration = '';
        if (contentDetails && contentDetails.duration) {
          const duration = contentDetails.duration;
          const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
          
          const hours = match[1] ? match[1].replace('H', '') : 0;
          const minutes = match[2] ? match[2].replace('M', '') : 0;
          const seconds = match[3] ? match[3].replace('S', '') : 0;
          
          if (hours > 0) {
            formattedDuration = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
          } else {
            formattedDuration = `${minutes}:${String(seconds).padStart(2, '0')}`;
          }
        }
        
        const thumbnails = snippet.thumbnails;
        const thumbnailUrl = thumbnails.maxres?.url || 
                           thumbnails.high?.url || 
                           thumbnails.medium?.url || 
                           thumbnails.default?.url;
        
        videoDetails = {
          title: snippet.title,
          channelTitle: snippet.channelTitle,
          publishedAt: snippet.publishedAt,
          description: snippet.description,
          thumbnailUrl: thumbnailUrl,
          viewCount: statistics?.viewCount,
          likeCount: statistics?.likeCount,
          commentCount: statistics?.commentCount,
          duration: formattedDuration
        };
        
        chapters = extractChaptersFromDescription(snippet.description);
        
        if (chapters.length === 0) {
          return res.status(400).json({ 
            message: 'This video does not have chapters. Currently, only videos with chapters are supported.' 
          });
        }
      }
    } catch (error) {
      console.error('Error fetching video details:', error);
      return res.status(500).json({ 
        message: 'Failed to fetch video details',
        error: error.message 
      });
    }
    
    // Fetch transcript
    try {
      const transcriptResponse = await YoutubeTranscript.fetchTranscript(videoId);
      
      if (!transcriptResponse || transcriptResponse.length === 0) {
        return res.status(404).json({ message: 'No transcript found for this video' });
      }
      
      const cleanTranscriptData = transcriptResponse.map(item => ({
        ...item,
        text: cleanHtmlEntities(item.text)
      }));
      
      const plainText = cleanTranscriptData
        .map(item => item.text)
        .join(' ')
        .replace(/\s+/g, ' ');
      
      const organizedTranscript = organizeTranscriptByChapters(cleanTranscriptData, chapters);
      
      res.json({
        videoDetails,
        chapters,
        transcript: plainText,
        transcriptData: cleanTranscriptData,
        organizedTranscript
      });
    } catch (error) {
      console.error('Error fetching transcript:', error);
      return res.status(404).json({ message: 'No transcript found for this video' });
    }
    
  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).json({ 
      message: 'Failed to process video',
      error: error.message 
    });
  }
});

// Endpoint to enhance chapters
app.post('/api/enhance-chapters', async (req, res) => {
  try {
    const { chapters } = req.body;
    
    if (!chapters || !Array.isArray(chapters) || chapters.length === 0) {
      return res.status(400).json({ message: 'Invalid chapters data' });
    }
    
    const enhancedChapters = [];
    
    for (const chapter of chapters) {
      try {
        const prompt = `You are an expert transcript editor specializing in improving the readability of automatically generated YouTube video transcripts. Your task is to enhance this transcript segment while preserving its complete meaning and information.

Please make these specific improvements:
1. Add proper punctuation (periods, commas, question marks)
2. Fix grammatical errors and sentence structure
3. Format into logical paragraphs based on topic changes
4. Clean up filler words (um, uh, like, you know) when excessive
5. Properly capitalize names, places, and beginnings of sentences
6. Preserve all factual information and technical terms
7. Maintain the speaker's original voice and style
8. Do not add any new information that wasn't in the original

Original transcript segment:
${chapter.content}

Provide the enhanced version that maintains all information but is easier to read.`;

        const response = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            { role: "system", content: "You are a helpful assistant that improves the readability of transcripts." },
            { role: "user", content: prompt }
          ],
          temperature: 0.3,
          max_tokens: 1500
        });
        
        enhancedChapters.push({
          ...chapter,
          enhancedContent: response.choices[0].message.content
        });
      } catch (error) {
        console.error(`Error enhancing chapter "${chapter.title}":`, error);
        enhancedChapters.push({
          ...chapter,
          enhancedContent: chapter.content
        });
      }
    }
    
    res.json({ enhancedChapters });
  } catch (error) {
    console.error('Error enhancing chapters:', error);
    res.status(500).json({ 
      message: 'Failed to enhance chapters',
      error: error.message 
    });
  }
});

// Endpoint to generate sequential analyses
app.post('/api/generate-sequential-analyses', async (req, res) => {
  try {
    const { chapters, startIndex, endIndex } = req.body;
    
    if (!chapters || !Array.isArray(chapters)) {
      return res.status(400).json({ message: 'Invalid chapters data' });
    }
    
    if (startIndex < 0 || endIndex >= chapters.length || startIndex > endIndex) {
      return res.status(400).json({ message: 'Invalid chapter indices' });
    }
    
    const chapterAnalyses = [];
    const contextSummaries = [];
    
    for (let i = startIndex; i <= endIndex; i++) {
      const chapter = chapters[i];
      
      try {
        let contextPrompt = '';
        if (contextSummaries.length > 0) {
          contextPrompt = 'Context from previous chapters:\n' +
            contextSummaries.map((summary, idx) => 
              `Chapter ${startIndex + idx + 1}: ${summary}`
            ).join('\n') + '\n\n';
        }
        
        const prompt = `${contextPrompt}${contextPrompt ? 'Current chapter to analyze:\n' : ''}You are an expert content analyst specializing in extracting valuable information from video transcripts. Analyze this transcript segment from the chapter titled "${chapter.title}" (chapter ${i + 1} of ${chapters.length}).

${contextPrompt ? 'Based on this context and the current chapter content, provide:' : 'Provide three distinct outputs:'}

1. QUICK SUMMARY:
   - Provide a concise summary of the main topic (max 200 words)
   - Focus on the central theme and core message
   - Be direct and to-the-point
   - Avoid tangential details
   - Make it easy to understand at a glance
   - For shorter content, keep summary proportionally brief

2. KEY TAKEAWAYS:
   - Extract the most important ideas, concepts, arguments, and facts
   - Focus on actionable insights and core messages
   - Use clear, concise language
   - Organize in bullet points
   - Connect to themes from previous chapters where relevant
   - Do not include your own opinions or interpretation
   - Only include information explicitly mentioned in the transcript
   - Length should be appropriate to content

3. MEMORABLE QUOTES:
   - Select the most impactful, insightful, or powerful direct quotes
   - Choose quotes that capture key messages or unique perspectives
   - Include only exact quotes from the transcript
   - For each quote, include exact phrasing (do not paraphrase)
   - If there are no notable quotes, skip this section entirely
   - Limit to 1-2 quotes unless the chapter is particularly long
   - Prioritize quotes that relate to ongoing themes where applicable

Format your response with clear headings for each section, and only include a MEMORABLE QUOTES section if worthwhile quotes exist.

Transcript:
${chapter.content}`;

        const response = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            { role: "system", content: "You are a helpful assistant that analyzes video transcripts while maintaining context from previous sections." },
            { role: "user", content: prompt }
          ],
          temperature: 0.3,
          max_tokens: 1000
        });
        
        const analysis = response.choices[0].message.content;
        
        let summary = '';
        let takeaways = '';
        let quotes = '';
        
        if (analysis.includes('QUICK SUMMARY')) {
          const summaryStart = analysis.indexOf('QUICK SUMMARY');
          let summaryEnd = analysis.indexOf('KEY TAKEAWAYS');
          
          if (summaryEnd !== -1) {
            summary = analysis.substring(summaryStart, summaryEnd).trim();
            summary = summary.replace('QUICK SUMMARY', '').trim();
            if (summary.startsWith(':')) {
              summary = summary.substring(1).trim();
            }
          }
        }
        
        if (analysis.includes('KEY TAKEAWAYS')) {
          const takeawaysStart = analysis.indexOf('KEY TAKEAWAYS');
          let takeawaysEnd = analysis.indexOf('MEMORABLE QUOTES');
          
          if (takeawaysEnd === -1) {
            takeawaysEnd = analysis.length;
          }
          
          takeaways = analysis.substring(takeawaysStart, takeawaysEnd).trim();
          takeaways = takeaways.replace('KEY TAKEAWAYS', '').trim();
          
          if (takeaways.startsWith(':')) {
            takeaways = takeaways.substring(1).trim();
          }
        }
        if (analysis.includes('MEMORABLE QUOTES')) {
          const quotesStart = analysis.indexOf('MEMORABLE QUOTES');
          quotes = analysis.substring(quotesStart).trim();
          quotes = quotes.replace('MEMORABLE QUOTES', '').trim();
          
          if (quotes.startsWith(':')) {
            quotes = quotes.substring(1).trim();
          }
        }
        
        // Store the analysis with summary
        chapterAnalyses.push({
          chapterIndex: i,
          summary,
          takeaways,
          quotes
        });
        
        // Add to context for next iteration
        contextSummaries.push(summary);
        
      } catch (error) {
        console.error(`Error analyzing chapter "${chapter.title}":`, error);
        // If analysis fails, push empty analysis but continue with others
        chapterAnalyses.push({
          chapterIndex: i,
          summary: '',
          takeaways: '',
          quotes: '',
          error: error.message
        });
        contextSummaries.push('');
      }
    }
    
    res.json({ chapterAnalyses });
  } catch (error) {
    console.error('Error generating sequential analyses:', error);
    res.status(500).json({ 
      message: 'Failed to generate analyses',
      error: error.message 
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('YouTube Transcript API is running');
});

// Start server
// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Add the new logging statements right here
  console.log(`CORS configured for origin: ${process.env.CORS_ORIGIN || 'http://localhost:3000'}`);
  console.log(`YouTube API Key configured: ${YOUTUBE_API_KEY ? 'Yes' : 'No'}`);
  console.log(`OpenAI API Key configured: ${process.env.OPENAI_API_KEY ? 'Yes' : 'No'}`);
});