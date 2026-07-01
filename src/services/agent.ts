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
import {
  getLiveEvents, getScheduledEvents, searchSportAPITeam,
  getTeamForm, getTeamNextEvents, searchSportAPIPlayer,
  getPlayerSeasonStats, getTransferNews, getPlayerRankings,
  SPORT_CATEGORY,
} from './sportapi';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_HISTORY = 20;
const MAX_TOOL_CALLS = 8;

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_today_football_fixtures',
      description: 'Get football/soccer matches happening today. Use to find today\'s games or schedules.',
      parameters: {
        type: 'object',
        properties: {
          league_id: {
            type: 'number',
            description: 'Optional league filter: 71=Brasileirão A, 72=Brasileirão B, 73=Copa do Brasil, 13=Libertadores, 2=Champions League, 39=Premier League, 140=La Liga, 135=Serie A, 78=Bundesliga, 1=World Cup',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_football_team',
      description: 'Search for a football team by name to get their ID. Always search before using team-based functions.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Team name e.g. "Flamengo", "Real Madrid"' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_team_recent_form',
      description: 'Get a football team\'s recent match results to analyze form, streaks, and goals.',
      parameters: {
        type: 'object',
        properties: {
          team_id: { type: 'number', description: 'Team ID from search_football_team' },
          last: { type: 'number', description: 'Number of recent matches (default 5)' },
        },
        required: ['team_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_head_to_head',
      description: 'Get historical head-to-head results between two football teams.',
      parameters: {
        type: 'object',
        properties: {
          team1_id: { type: 'number', description: 'First team ID' },
          team2_id: { type: 'number', description: 'Second team ID' },
          last: { type: 'number', description: 'Number of past matches (default 10)' },
        },
        required: ['team1_id', 'team2_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_fixture_injuries',
      description: 'Get injury and suspension list for a specific fixture.',
      parameters: {
        type: 'object',
        properties: {
          fixture_id: { type: 'number', description: 'Fixture ID from get_today_football_fixtures' },
        },
        required: ['fixture_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_league_standings',
      description: 'Get current league table showing team rankings, points, wins, losses.',
      parameters: {
        type: 'object',
        properties: {
          league_id: { type: 'number', description: 'League ID' },
          season: { type: 'number', description: 'Season year e.g. 2025' },
        },
        required: ['league_id', 'season'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_betting_odds',
      description: 'Get real-time betting odds from multiple bookmakers for any sport.',
      parameters: {
        type: 'object',
        properties: {
          sport_key: {
            type: 'string',
            description: 'Sport: soccer_brazil_campeonato, soccer_epl, soccer_uefa_champs_league, soccer_spain_la_liga, soccer_italy_serie_a, soccer_germany_bundesliga, basketball_nba, mma_mixed_martial_arts, americanfootball_nfl, tennis_atp',
          },
          regions: {
            type: 'string',
            description: 'Bookmaker regions: eu (default, Bet365/Betfair), us, uk, au',
          },
        },
        required: ['sport_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_value_bets',
      description: 'Find value bets with positive expected value by comparing odds across multiple bookmakers using no-vig fair probability algorithm.',
      parameters: {
        type: 'object',
        properties: {
          sport_key: { type: 'string', description: 'Sport key (same options as get_betting_odds)' },
          min_edge: { type: 'number', description: 'Minimum edge 0-1 (default 0.05 = 5%)' },
        },
        required: ['sport_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_football_player',
      description: 'Search for a football player by name to get their ID for stats lookup.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Player name e.g. "Neymar", "Messi", "Vini Jr"' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_player_stats',
      description: 'Get detailed player statistics: goals, assists, matches, rating.',
      parameters: {
        type: 'object',
        properties: {
          player_id: { type: 'number', description: 'Player ID from search_football_player' },
          league_id: { type: 'number', description: 'League ID' },
          season: { type: 'number', description: 'Season year e.g. 2024' },
        },
        required: ['player_id', 'league_id', 'season'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_nba_games',
      description: 'Get NBA basketball games for today or a specific date.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format (omit for today)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_nba_standings',
      description: 'Get current NBA standings for both conferences.',
      parameters: {
        type: 'object',
        properties: {
          season: { type: 'string', description: 'Season e.g. "2024-2025"' },
        },
        required: ['season'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_mma_events',
      description: 'Get upcoming UFC/MMA events and fight cards.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_mma_fighter',
      description: 'Search for an MMA/UFC fighter by name to get their record and stats.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Fighter name e.g. "Jon Jones", "Alex Pereira", "Poatan"' },
        },
        required: ['name'],
      },
    },
  },
  // ─── SportAPI tools ───────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_live_events',
      description: 'Get all currently live events across all sports or a specific sport. Use when user asks "o que está acontecendo agora", "jogos ao vivo", "live right now".',
      parameters: {
        type: 'object',
        properties: {
          sport: {
            type: 'string',
            description: 'Optional: football, basketball, tennis, mma, esports, american_football',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_scheduled_events_by_sport',
      description: 'Get all scheduled events for a sport on a given date. Broader coverage than API-Sports. Good for finding all matches across all competitions.',
      parameters: {
        type: 'object',
        properties: {
          sport: {
            type: 'string',
            description: 'Sport: football, basketball, tennis, mma, esports, american_football, ice_hockey, volleyball',
          },
          date: { type: 'string', description: 'Date YYYY-MM-DD (omit for today)' },
        },
        required: ['sport'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_team_form_sportapi',
      description: 'Get a team\'s recent form and next fixtures via SportAPI. Provides W/D/L results with scores.',
      parameters: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Team name to search' },
        },
        required: ['team_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transfer_news',
      description: 'Get recent transfer news for a team or globally. Transfers affect team strength and can create pricing inefficiencies in bookmaker odds.',
      parameters: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Optional team name to get team-specific transfers' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_player_rankings',
      description: 'Get ATP/WTA tennis rankings or NBA standings-based rankings.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['atp', 'wta', 'nba'],
            description: 'Ranking type',
          },
        },
        required: ['type'],
      },
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

const SPORT_CAT_MAP: Record<string, number> = {
  football: SPORT_CATEGORY.FOOTBALL,
  basketball: SPORT_CATEGORY.BASKETBALL,
  tennis: SPORT_CATEGORY.TENNIS,
  mma: SPORT_CATEGORY.MMA,
  esports: SPORT_CATEGORY.ESPORTS,
  american_football: SPORT_CATEGORY.AMERICAN_FOOTBALL,
  ice_hockey: SPORT_CATEGORY.ICE_HOCKEY,
  volleyball: SPORT_CATEGORY.VOLLEYBALL,
};

async function executeTool(name: string, args: any): Promise<any> {
  console.log(`🔧 Tool: ${name}`, JSON.stringify(args));
  switch (name) {
    case 'get_today_football_fixtures':
      return getTodayFixtures(args.league_id);
    case 'search_football_team':
      return searchTeam(args.name);
    case 'get_team_recent_form':
      return getTeamRecentFixtures(args.team_id, args.last || 5);
    case 'get_head_to_head':
      return getH2H(args.team1_id, args.team2_id, args.last || 10);
    case 'get_fixture_injuries':
      return getFixtureInjuries(args.fixture_id);
    case 'get_league_standings':
      return getStandings(args.league_id, args.season);
    case 'get_betting_odds':
      return getOdds(args.sport_key, args.regions || 'eu');
    case 'find_value_bets': {
      const events = await getOdds(args.sport_key, 'eu');
      return findValueBets(events, args.min_edge || 0.05);
    }
    case 'search_football_player':
      return searchPlayer(args.name);
    case 'get_player_stats':
      return getPlayerStatistics(args.player_id, args.league_id, args.season);
    case 'get_nba_games':
      return args.date ? getNBAGamesByDate(args.date) : getNBAGamesToday();
    case 'get_nba_standings':
      return getNBAStandings(args.season);
    case 'get_mma_events':
      return getUpcomingEvents();
    case 'search_mma_fighter':
      return searchFighter(args.name);
    // SportAPI tools
    case 'get_live_events': {
      const catId = args.sport ? SPORT_CAT_MAP[args.sport.toLowerCase()] : undefined;
      return getLiveEvents(catId);
    }
    case 'get_scheduled_events_by_sport': {
      const catId = SPORT_CAT_MAP[args.sport?.toLowerCase()] || SPORT_CATEGORY.FOOTBALL;
      return getScheduledEvents(catId, args.date);
    }
    case 'get_team_form_sportapi': {
      const teams = await searchSportAPITeam(args.team_name);
      if (!teams.length || !teams[0].id) return { error: 'Team not found' };
      const [form, nextMatches] = await Promise.all([
        getTeamForm(teams[0].id),
        getTeamNextEvents(teams[0].id),
      ]);
      return { team: teams[0], recent_form: form, next_matches: nextMatches };
    }
    case 'get_transfer_news': {
      if (args.team_name) {
        const teams = await searchSportAPITeam(args.team_name);
        if (teams.length && teams[0].id) return getTransferNews(teams[0].id);
      }
      return getTransferNews();
    }
    case 'get_player_rankings':
      return getPlayerRankings(args.type || 'atp');
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Conversation history ─────────────────────────────────────────────────────

export async function getConversationHistory(phone: string): Promise<Message[]> {
  const rows = await query<{ role: string; content: string }>(
    `SELECT role, content FROM conversations WHERE phone = $1 ORDER BY created_at DESC LIMIT $2`,
    [phone, MAX_HISTORY]
  );
  return rows.reverse() as Message[];
}

export async function saveMessage(
  phone: string,
  userId: string | null,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  await query(
    `INSERT INTO conversations (user_id, phone, role, content) VALUES ($1, $2, $3, $4)`,
    [userId, phone, role, content]
  );
}

export async function clearConversationHistory(phone: string): Promise<void> {
  await query(`DELETE FROM conversations WHERE phone = $1`, [phone]);
}

// ─── Main agent with tool calling loop ───────────────────────────────────────

export async function runAgent(
  phone: string,
  userMessage: string,
  userId: string | null
): Promise<string> {
  await saveMessage(phone, userId, 'user', userMessage);
  const history = await getConversationHistory(phone);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
  ];

  let toolCallCount = 0;

  let response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    max_tokens: 1200,
    temperature: 0.7,
  });

  while (response.choices[0]?.finish_reason === 'tool_calls' && toolCallCount < MAX_TOOL_CALLS) {
    const toolCalls = response.choices[0].message.tool_calls!;
    messages.push(response.choices[0].message);

    for (const tc of toolCalls) {
      let result: any;
      try {
        result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments));
      } catch (err) {
        console.error(`Tool error: ${tc.function.name}`, err);
        result = { error: 'Failed to fetch data' };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
      toolCallCount++;
    }

    response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 1200,
      temperature: 0.7,
    });
  }

  const assistantMessage =
    response.choices[0]?.message?.content ||
    'Desculpe, não consegui processar sua mensagem. Tente novamente.';

  await saveMessage(phone, userId, 'assistant', assistantMessage);
  console.log(`🤖 GPT-4o tokens: ${response.usage?.total_tokens ?? '?'} | tools: ${toolCallCount}`);

  return assistantMessage;
}

// ─── Audio transcription (Whisper) ───────────────────────────────────────────

export async function transcribeAudio(audioUrl: string): Promise<string> {
  const audioResponse = await axios.get(audioUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
  });
  const buffer = Buffer.from(audioResponse.data);
  const contentType = (audioResponse.headers['content-type'] as string) || 'audio/ogg';
  const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('mpeg') ? 'mp3' : 'ogg';
  const file = new File([buffer], `audio.${ext}`, { type: contentType });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
  });
  return transcription.text;
}

// ─── Image analysis (GPT-4o Vision) ──────────────────────────────────────────

export async function runAgentWithImage(
  phone: string,
  imageUrl: string,
  caption: string,
  userId: string | null
): Promise<string> {
  const savedText = caption ? `[Imagem] ${caption}` : '[Imagem enviada para análise]';
  await saveMessage(phone, userId, 'user', savedText);
  const history = await getConversationHistory(phone);

  const userText =
    caption ||
    'Analise essa imagem. Se for uma boleta de apostas, analise as odds, calcule o retorno potencial, identifique value bets e aponte riscos. Se for algo relacionado a esportes, forneça análise relevante.';

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
      ],
    },
  ];

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      max_tokens: 1200,
      temperature: 0.7,
    });
    const assistantMessage =
      response.choices[0]?.message?.content ||
      '❌ Não consegui analisar a imagem. Tente enviar novamente.';
    await saveMessage(phone, userId, 'assistant', assistantMessage);
    return assistantMessage;
  } catch (err) {
    console.error('Image analysis error:', err);
    return '❌ Erro ao analisar a imagem. Certifique-se de enviar uma foto clara.';
  }
}
