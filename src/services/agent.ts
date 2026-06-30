import OpenAI from 'openai';
import axios from 'axios';
import { query } from '../db';
import { SYSTEM_PROMPT } from '../prompts/system';
import {
  getTodayFixtures, searchTeam, getTeamRecentFixtures,
  getH2H, getFixtureInjuries, getStandings,
  searchPlayer, getPlayerStatistics,
} from './sports';
import { getOdds, findValueBets } from './odds';
import { getNBAGamesToday, getNBAGamesByDate, getNBAStandings } from './basketball';
import { getUpcomingEvents, searchFighter } from './mma';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_HISTORY = 20;
const MAX_TOOL_CALLS = 6;

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_today_football_fixtures',
      description: 'Get football/soccer matches happening today. Use to find today\'s games or schedules.',
      parameters: {
        type: 'object',
        properties: {
          league_id: { type: 'number', description: 'Optional: 71=Brasileirao A, 72=B, 73=Copa Brasil, 13=Libertadores, 2=Champions, 39=Premier, 140=La Liga, 135=Serie A, 78=Bundesliga, 1=World Cup' },
        },
      },
    },
  },
  { type: 'function', function: { name: 'search_football_team', description: 'Search for a football team by name to get ID.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'get_team_recent_form', description: 'Get recent match results for a team.', parameters: { type: 'object', properties: { team_id: { type: 'number' }, last: { type: 'number' } }, required: ['team_id'] } } },
  { type: 'function', function: { name: 'get_head_to_head', description: 'Get H2H history between two teams.', parameters: { type: 'object', properties: { team1_id: { type: 'number' }, team2_id: { type: 'number' }, last: { type: 'number' } }, required: ['team1_id', 'team2_id'] } } },
  { type: 'function', function: { name: 'get_fixture_injuries', description: 'Get injuries/suspensions for a fixture.', parameters: { type: 'object', properties: { fixture_id: { type: 'number' } }, required: ['fixture_id'] } } },
  { type: 'function', function: { name: 'get_league_standings', description: 'Get league table standings.', parameters: { type: 'object', properties: { league_id: { type: 'number' }, season: { type: 'number' } }, required: ['league_id', 'season'] } } },
  { type: 'function', function: { name: 'get_betting_odds', description: 'Get real-time betting odds from multiple bookmakers.', parameters: { type: 'object', properties: { sport_key: { type: 'string', description: 'soccer_brazil_campeonato, soccer_epl, soccer_uefa_champs_league, soccer_spain_la_liga, basketball_nba, mma_mixed_martial_arts, americanfootball_nfl, tennis_atp' }, regions: { type: 'string', description: 'eu (default), us, uk' } }, required: ['sport_key'] } } },
  { type: 'function', function: { name: 'find_value_bets', description: 'Find value bets with positive expected value across bookmakers.', parameters: { type: 'object', properties: { sport_key: { type: 'string' }, min_edge: { type: 'number' } }, required: ['sport_key'] } } },
  { type: 'function', function: { name: 'search_football_player', description: 'Search player by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'get_player_stats', description: 'Get player stats for season.', parameters: { type: 'object', properties: { player_id: { type: 'number' }, league_id: { type: 'number' }, season: { type: 'number' } }, required: ['player_id', 'league_id', 'season'] } } },
  { type: 'function', function: { name: 'get_nba_games', description: 'Get NBA games today or by date.', parameters: { type: 'object', properties: { date: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_nba_standings', description: 'Get NBA standings.', parameters: { type: 'object', properties: { season: { type: 'string' } }, required: ['season'] } } },
  { type: 'function', function: { name: 'get_mma_events', description: 'Get upcoming UFC/MMA events.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'search_mma_fighter', description: 'Search MMA fighter by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
];

async function executeTool(name: string, args: any): Promise<any> {
  console.log(`Tool: ${name}`, JSON.stringify(args));
  switch (name) {
    case 'get_today_football_fixtures': return getTodayFixtures(args.league_id);
    case 'search_football_team': return searchTeam(args.name);
    case 'get_team_recent_form': return getTeamRecentFixtures(args.team_id, args.last || 5);
    case 'get_head_to_head': return getH2H(args.team1_id, args.team2_id, args.last || 10);
    case 'get_fixture_injuries': return getFixtureInjuries(args.fixture_id);
    case 'get_league_standings': return getStandings(args.league_id, args.season);
    case 'get_betting_odds': return getOdds(args.sport_key, args.regions || 'eu');
    case 'find_value_bets': { const events = await getOdds(args.sport_key, 'eu'); return findValueBets(events, args.min_edge || 0.05); }
    case 'search_football_player': return searchPlayer(args.name);
    case 'get_player_stats': return getPlayerStatistics(args.player_id, args.league_id, args.season);
    case 'get_nba_games': return args.date ? getNBAGamesByDate(args.date) : getNBAGamesToday();
    case 'get_nba_standings': return getNBAStandings(args.season);
    case 'get_mma_events': return getUpcomingEvents();
    case 'search_mma_fighter': return searchFighter(args.name);
    default: return { error: `Unknown tool: ${name}` };
  }
}

export async function getConversationHistory(phone: string): Promise<Message[]> {
  const rows = await query<{ role: string; content: string }>(
    `SELECT role, content FROM conversations WHERE phone = $1 ORDER BY created_at DESC LIMIT $2`,
    [phone, MAX_HISTORY]
  );
  return rows.reverse() as Message[];
}

export async function saveMessage(phone: string, userId: string | null, role: 'user' | 'assistant', content: string): Promise<void> {
  await query(`INSERT INTO conversations (user_id, phone, role, content) VALUES ($1, $2, $3, $4)`, [userId, phone, role, content]);
}

export async function clearConversationHistory(phone: string): Promise<void> {
  await query(`DELETE FROM conversations WHERE phone = $1`, [phone]);
}

export async function runAgent(phone: string, userMessage: string, userId: string | null): Promise<string> {
  await saveMessage(phone, userId, 'user', userMessage);
  const history = await getConversationHistory(phone);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
  ];
  let toolCallCount = 0;
  let response = await openai.chat.completions.create({ model: 'gpt-4o', messages, tools: TOOLS, tool_choice: 'auto', max_tokens: 1200, temperature: 0.7 });
  while (response.choices[0]?.finish_reason === 'tool_calls' && toolCallCount < MAX_TOOL_CALLS) {
    const toolCalls = response.choices[0].message.tool_calls!;
    messages.push(response.choices[0].message);
    for (const tc of toolCalls) {
      let result: any;
      try { result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments)); }
      catch (err) { console.error(`Tool error: ${tc.function.name}`, err); result = { error: 'Failed to fetch data' }; }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      toolCallCount++;
    }
    response = await openai.chat.completions.create({ model: 'gpt-4o', messages, tools: TOOLS, tool_choice: 'auto', max_tokens: 1200, temperature: 0.7 });
  }
  const assistantMessage = response.choices[0]?.message?.content || 'Desculpe, nao consegui processar. Tente novamente.';
  await saveMessage(phone, userId, 'assistant', assistantMessage);
  console.log(`GPT-4o tokens: ${response.usage?.total_tokens ?? '?'} | tools: ${toolCallCount}`);
  return assistantMessage;
}

export async function transcribeAudio(audioUrl: string): Promise<string> {
  const audioResponse = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 20000 });
  const buffer = Buffer.from(audioResponse.data);
  const contentType = (audioResponse.headers['content-type'] as string) || 'audio/ogg';
  const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('mpeg') ? 'mp3' : 'ogg';
  const file = new File([buffer], `audio.${ext}`, { type: contentType });
  const transcription = await openai.audio.transcriptions.create({ file, model: 'whisper-1' });
  return transcription.text;
}

export async function runAgentWithImage(phone: string, imageUrl: string, caption: string, userId: string | null): Promise<string> {
  const savedText = caption ? `[Imagem] ${caption}` : '[Imagem enviada para analise]';
  await saveMessage(phone, userId, 'user', savedText);
  const history = await getConversationHistory(phone);
  const userText = caption || 'Analise essa imagem. Se for uma boleta de apostas, analise as odds, calcule o retorno potencial, identifique value bets e aponte riscos.';
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user', content: [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }] },
  ];
  try {
    const response = await openai.chat.completions.create({ model: 'gpt-4o', messages, max_tokens: 1200, temperature: 0.7 });
    const assistantMessage = response.choices[0]?.message?.content || 'Nao consegui analisar a imagem. Tente novamente.';
    await saveMessage(phone, userId, 'assistant', assistantMessage);
    return assistantMessage;
  } catch (err) {
    console.error('Image analysis error:', err);
    return 'Erro ao analisar a imagem. Certifique-se de enviar uma foto clara.';
  }
}
