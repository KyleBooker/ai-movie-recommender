import type { APIGatewayProxyHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';

const TABLE_NAME = process.env.TABLE_NAME!;
const REQUESTS_TABLE_NAME = process.env.REQUESTS_TABLE_NAME!;
const SETTINGS_TABLE_NAME = process.env.SETTINGS_TABLE_NAME!;
const MODEL_ID = process.env.MODEL_ID!;
const LEGACY_SHARED_USER_ID = 'kyle';
const NUM_RECOMMENDATIONS = 3;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const bedrock = new BedrockRuntimeClient({});

type WatchedMovie = {
  title: string;
  year: number;
  playCount: number;
  completed: boolean;
};

// Fallback taste profile used when a user hasn't imported any Tautulli history
// yet. A diverse mix of acclaimed films across genres and eras so the model has
// good signal out of the box. Replaced entirely once the user imports.
const DEFAULT_WATCH_HISTORY: WatchedMovie[] = [
  { title: "Normal", year: 2026, playCount: 1, completed: false },
  { title: "Project Hail Mary", year: 2026, playCount: 1, completed: true },
  { title: "The Devil Wears Prada", year: 2006, playCount: 4, completed: true },
  { title: "The Legend of Aang: The Last Airbender", year: 2026, playCount: 1, completed: true },
  { title: "Groundhog Day", year: 1993, playCount: 1, completed: true },
  { title: "Finding Harry: The Craft Behind the Magic", year: 2026, playCount: 1, completed: true },
  { title: "Project Hail Mary", year: 2026, playCount: 1, completed: false },
  { title: "Noroi: The Curse", year: 2005, playCount: 1, completed: true },
  { title: "Drive", year: 2011, playCount: 2, completed: false },
  { title: "The Bride!", year: 2026, playCount: 1, completed: true },
  { title: "Send Help", year: 2026, playCount: 1, completed: true },
  { title: "The Wild Robot", year: 2024, playCount: 2, completed: true },
  { title: "Your Name.", year: 2016, playCount: 9, completed: true },
  { title: "The Housemaid", year: 2025, playCount: 1, completed: true },
  { title: "Taylor Swift: The Eras Tour - The Final Show", year: 2025, playCount: 4, completed: true },
  { title: "Hamnet", year: 2025, playCount: 1, completed: true },
  { title: "Wake Up Dead Man", year: 2025, playCount: 1, completed: false },
  { title: "Mercy", year: 2026, playCount: 1, completed: false },
  { title: "Glass Onion", year: 2022, playCount: 1, completed: true },
  { title: "Knives Out", year: 2019, playCount: 2, completed: true },
  { title: "Erin Brockovich", year: 2000, playCount: 1, completed: true },
  { title: "Exit 8", year: 2025, playCount: 2, completed: false },
  { title: "Hamnet", year: 2025, playCount: 1, completed: true },
  { title: "Best Wishes, Warmest Regards: A Schitt's Creek Farewell", year: 2020, playCount: 1, completed: true },
  { title: "Weapons", year: 2025, playCount: 1, completed: true },
  { title: "Skyscraper Live", year: 2026, playCount: 1, completed: true },
  { title: "The Muppet Show", year: 2026, playCount: 1, completed: true },
  { title: "Home Alone", year: 1990, playCount: 1, completed: false },
  { title: "Blades of Glory", year: 2007, playCount: 2, completed: true },
  { title: "Parasite", year: 2019, playCount: 3, completed: true },
  { title: "Barbie", year: 2023, playCount: 1, completed: true },
  { title: "One Last Adventure: The Making of Stranger Things 5", year: 2026, playCount: 1, completed: false },
  { title: "Joker: Folie à Deux", year: 2024, playCount: 1, completed: true },
  { title: "The Alto Knights", year: 2025, playCount: 1, completed: true },
  { title: "The Lord of the Rings: The Fellowship of the Ring", year: 2001, playCount: 1, completed: false },
  { title: "Zootopia 2", year: 2025, playCount: 1, completed: true },
  { title: "Five Nights at Freddy's 2", year: 2025, playCount: 1, completed: true },
  { title: "Demon Slayer: Kimetsu no Yaiba Infinity Castle", year: 2025, playCount: 1, completed: false },
  { title: "It Ends", year: 2025, playCount: 1, completed: true },
  { title: "Spy", year: 2015, playCount: 1, completed: true },
  { title: "Taylor Swift: The Eras Tour", year: 2023, playCount: 5, completed: true },
  { title: "Zootopia", year: 2016, playCount: 1, completed: true },
  { title: "Hazbin Hotel: Live on Broadway", year: 2025, playCount: 1, completed: true },
  { title: "Humane", year: 2024, playCount: 1, completed: true },
  { title: "Save the Green Planet!", year: 2003, playCount: 1, completed: true },
  { title: "Bugonia", year: 2025, playCount: 1, completed: true },
  { title: "Unbreakable Kimmy Schmidt: Kimmy vs the Reverend", year: 2020, playCount: 1, completed: true },
  { title: "Wicked", year: 2023, playCount: 1, completed: true },
  { title: "Shelby Oaks", year: 2025, playCount: 1, completed: true },
  { title: "Wicked: One Wonderful Night", year: 2025, playCount: 2, completed: true },
  { title: "Shrek the Third", year: 2007, playCount: 1, completed: true },
  { title: "Shrek 2", year: 2004, playCount: 1, completed: true },
  { title: "Shrek", year: 2001, playCount: 1, completed: true },
  { title: "Se7en", year: 1995, playCount: 1, completed: true },
  { title: "Good Fortune", year: 2025, playCount: 1, completed: false },
  { title: "Taylor Swift: The Eras Tour", year: 2023, playCount: 10, completed: true },
  { title: "Incredibles 2", year: 2018, playCount: 1, completed: true },
  { title: "It", year: 2017, playCount: 1, completed: true },
  { title: "Scott Pilgrim vs. the World", year: 2010, playCount: 1, completed: true },
  { title: "The Incredibles", year: 2004, playCount: 1, completed: false },
  { title: "The Rocky Horror Picture Show", year: 1975, playCount: 2, completed: true },
  { title: "X-Men", year: 2000, playCount: 1, completed: false },
  { title: "I See You", year: 2019, playCount: 1, completed: true },
  { title: "Famous Last Words: Dr. Jane Goodall", year: 2025, playCount: 1, completed: false },
  { title: "V/H/S/Halloween", year: 2025, playCount: 2, completed: true },
  { title: "The Perfect Neighbor", year: 2025, playCount: 1, completed: true },
  { title: "Akeelah and the Bee", year: 2006, playCount: 1, completed: true },
  { title: "Cats", year: 2019, playCount: 1, completed: true },
  { title: "Your Host", year: 2025, playCount: 2, completed: true },
  { title: "KPop Demon Hunters", year: 2025, playCount: 2, completed: true },
  { title: "The Black Phone", year: 2021, playCount: 1, completed: true },
  { title: "Another Simple Favor", year: 2025, playCount: 1, completed: false },
  { title: "A Simple Favor", year: 2018, playCount: 1, completed: true },
  { title: "Freakier Friday", year: 2025, playCount: 2, completed: true },
  { title: "Chicago", year: 2002, playCount: 1, completed: true },
  { title: "Him", year: 2025, playCount: 1, completed: true },
  { title: "The Descent: Part 2", year: 2009, playCount: 1, completed: true },
  { title: "The Descent", year: 2005, playCount: 1, completed: true },
  { title: "Terrifier 2", year: 2022, playCount: 1, completed: false },
  { title: "The Poughkeepsie Tapes", year: 2007, playCount: 1, completed: true },
  { title: "Poor Things", year: 2023, playCount: 1, completed: true },
  { title: "Megan Is Missing", year: 2011, playCount: 1, completed: true },
  { title: "Ne Zha 2", year: 2025, playCount: 1, completed: false },
  { title: "War of the Worlds", year: 2025, playCount: 2, completed: true },
  { title: "Elio", year: 2025, playCount: 1, completed: false },
  { title: "How to Train Your Dragon", year: 2025, playCount: 1, completed: true },
  { title: "Frozen II", year: 2019, playCount: 1, completed: true },
  { title: "Frozen", year: 2013, playCount: 1, completed: true },
  { title: "Together", year: 2025, playCount: 2, completed: true },
  { title: "Oppenheimer", year: 2023, playCount: 1, completed: true },
  { title: "Avatar", year: 2009, playCount: 1, completed: false },
  { title: "M3GAN 2.0", year: 2025, playCount: 2, completed: true },
  { title: "Bring Her Back", year: 2025, playCount: 2, completed: true },
  { title: "Ed Kemper", year: 2025, playCount: 1, completed: false },
  { title: "Thunderbolts*", year: 2025, playCount: 2, completed: true },
  { title: "Interstellar", year: 2014, playCount: 2, completed: true },
  { title: "Final Destination: Bloodlines", year: 2025, playCount: 2, completed: true },
  { title: "Coraline", year: 2009, playCount: 2, completed: true },
  { title: "Blade Runner 2049", year: 2017, playCount: 1, completed: true },
  { title: "The Wild Robot", year: 2024, playCount: 10, completed: true },
  { title: "Fantastic Four", year: 2015, playCount: 1, completed: true },
  { title: "The Amateur", year: 2025, playCount: 1, completed: false },
  { title: "Trainwreck: Poop Cruise", year: 2025, playCount: 1, completed: false },
  { title: "Fantastic Four: Rise of the Silver Surfer", year: 2007, playCount: 1, completed: false },
  { title: "Fantastic Four", year: 2005, playCount: 2, completed: true },
  { title: "A Minecraft Movie", year: 2025, playCount: 1, completed: false },
  { title: "The Phoenician Scheme", year: 2025, playCount: 1, completed: false },
  { title: "Iron Man", year: 2008, playCount: 1, completed: true },
  { title: "The New Mutants", year: 2020, playCount: 1, completed: true },
  { title: "X-Men: Dark Phoenix", year: 2019, playCount: 1, completed: true },
  { title: "Logan", year: 2017, playCount: 1, completed: true },
  { title: "X-Men: Apocalypse", year: 2016, playCount: 1, completed: true },
  { title: "X-Men: Days of Future Past", year: 2014, playCount: 1, completed: true },
  { title: "The Wolverine", year: 2013, playCount: 1, completed: true },
  { title: "X-Men: First Class", year: 2011, playCount: 1, completed: true },
  { title: "X-Men Origins: Wolverine", year: 2009, playCount: 1, completed: true },
  { title: "X-Men: The Last Stand", year: 2006, playCount: 1, completed: true },
  { title: "X2: X-Men United", year: 2003, playCount: 1, completed: true },
  { title: "Sinners", year: 2025, playCount: 1, completed: false },
  { title: "Sinners", year: 2025, playCount: 1, completed: false },
  { title: "X-Men", year: 2000, playCount: 1, completed: true },
  { title: "Until Dawn", year: 2025, playCount: 1, completed: true },
  { title: "Final Destination 5", year: 2011, playCount: 1, completed: true },
  { title: "The Final Destination", year: 2009, playCount: 1, completed: true },
  { title: "Final Destination 3", year: 2006, playCount: 1, completed: true },
  { title: "Final Destination 2", year: 2003, playCount: 1, completed: true },
  { title: "Final Destination", year: 2000, playCount: 1, completed: true },
  { title: "Snow White", year: 2025, playCount: 1, completed: false },
  { title: "Death of a Unicorn", year: 2025, playCount: 1, completed: true },
  { title: "The Shawshank Redemption", year: 1994, playCount: 3, completed: true },
  { title: "Mother!", year: 2017, playCount: 2, completed: true },
  { title: "The Monkey", year: 2025, playCount: 2, completed: true },
  { title: "Wrong Turn", year: 2021, playCount: 1, completed: true },
  { title: "Captain America: Brave New World", year: 2025, playCount: 1, completed: false },
  { title: "Companion", year: 2025, playCount: 1, completed: true },
  { title: "Fresh", year: 2022, playCount: 1, completed: true },
  { title: "Ladies & Gentlemen... 50 Years of SNL Music", year: 2025, playCount: 1, completed: false },
  { title: "Into the Woods", year: 1987, playCount: 1, completed: true },
  { title: "Wicked", year: 2024, playCount: 6, completed: true },
  { title: "Trisha Paytas' Big Broadway Dream", year: 2025, playCount: 1, completed: false },
  { title: "Stream", year: 2024, playCount: 2, completed: true },
  { title: "Water for Elephants", year: 2024, playCount: 1, completed: false },
  { title: "Hadestown", year: 2023, playCount: 1, completed: false },
  { title: "Frozen", year: 2023, playCount: 1, completed: true },
  { title: "Nosferatu", year: 2024, playCount: 1, completed: false },
  { title: "Ex Machina", year: 2014, playCount: 1, completed: true },
  { title: "Playtime", year: 1967, playCount: 1, completed: false },
  { title: "Queer", year: 2024, playCount: 1, completed: true },
  { title: "Fargo", year: 1996, playCount: 2, completed: true },
  { title: "Cunk on Life", year: 2024, playCount: 1, completed: false },
  { title: "Emilia Pérez", year: 2024, playCount: 1, completed: false },
  { title: "Homefront", year: 2013, playCount: 1, completed: false },
  { title: "Moana 2", year: 2024, playCount: 1, completed: false },
  { title: "Megalopolis", year: 2024, playCount: 1, completed: false },
  { title: "It's What's Inside", year: 2024, playCount: 3, completed: true },
  { title: "Evil Dead", year: 2013, playCount: 1, completed: true },
  { title: "Infinity Pool", year: 2023, playCount: 1, completed: false },
  { title: "Taylor Swift: Reputation Stadium Tour", year: 2018, playCount: 1, completed: true },
  { title: "Smile 2", year: 2024, playCount: 3, completed: true },
  { title: "Heretic", year: 2024, playCount: 1, completed: true },
  { title: "A Nonsense Christmas with Sabrina Carpenter", year: 2024, playCount: 1, completed: true },
  { title: "Wicked", year: 2024, playCount: 1, completed: false },
  { title: "The Wizard of Oz", year: 1939, playCount: 1, completed: true },
  { title: "Moana", year: 2016, playCount: 1, completed: false },
  { title: "The Substance", year: 2024, playCount: 1, completed: true },
  { title: "Speak No Evil", year: 2022, playCount: 1, completed: true },
  { title: "Speak No Evil", year: 2024, playCount: 1, completed: true },
  { title: "Terrified", year: 2018, playCount: 1, completed: true },
  { title: "Terrifier 3", year: 2024, playCount: 1, completed: true },
  { title: "Am I Racist?", year: 2024, playCount: 1, completed: false },
  { title: "Olivia Rodrigo: GUTS World Tour", year: 2024, playCount: 1, completed: true },
  { title: "Vivarium", year: 2019, playCount: 1, completed: true },
  { title: "Woman of the Hour", year: 2024, playCount: 1, completed: true },
  { title: "Everything Everywhere All at Once", year: 2022, playCount: 1, completed: true },
  { title: "The House That Jack Built", year: 2018, playCount: 1, completed: false },
  { title: "Dune: Part Two", year: 2024, playCount: 1, completed: true },
  { title: "The Texas Chain Saw Massacre: 50th Anniversary", year: 1974, playCount: 1, completed: true },
  { title: "Haunt", year: 2019, playCount: 1, completed: true },
  { title: "Hostel", year: 2005, playCount: 1, completed: false },
  { title: "Hostel: Part II", year: 2007, playCount: 1, completed: true },
  { title: "The Substance", year: 2024, playCount: 1, completed: false },
  { title: "Beetlejuice Beetlejuice", year: 2024, playCount: 1, completed: true },
  { title: "Will & Harper", year: 2024, playCount: 1, completed: true },
  { title: "The Platform 2", year: 2024, playCount: 1, completed: false },
  { title: "Deadpool & Wolverine", year: 2024, playCount: 1, completed: true },
  { title: "Beetlejuice", year: 1988, playCount: 3, completed: true },
  { title: "Forrest Gump", year: 1994, playCount: 1, completed: false },
  { title: "Trap", year: 2024, playCount: 1, completed: false },
  { title: "Kinds of Kindness", year: 2024, playCount: 2, completed: true },
  { title: "A Quiet Place: Day One", year: 2024, playCount: 3, completed: false },
  { title: "X", year: 2022, playCount: 2, completed: true },
  { title: "Twisters", year: 2024, playCount: 1, completed: false },
  { title: "Dune: Part Two", year: 2024, playCount: 4, completed: true },
  { title: "Inside Out 2", year: 2024, playCount: 1, completed: false },
  { title: "MaXXXine", year: 2024, playCount: 1, completed: true },
  { title: "Fan Edit: Breaking Bad Movie", year: 2019, playCount: 1, completed: false },
  { title: "Oddity", year: 2024, playCount: 1, completed: false },
  { title: "Trouble with the Curve", year: 2012, playCount: 1, completed: true },
  { title: "Civil War", year: 2024, playCount: 1, completed: true },
  { title: "Despicable Me 4", year: 2024, playCount: 1, completed: true },
  { title: "The Iron Giant", year: 1999, playCount: 1, completed: true },
  { title: "Kingdom of the Planet of the Apes", year: 2024, playCount: 1, completed: false },
  { title: "I Saw the TV Glow", year: 2024, playCount: 1, completed: true },
  { title: "The Sadness", year: 2021, playCount: 2, completed: true },
  { title: "Furiosa: A Mad Max Saga", year: 2024, playCount: 1, completed: true },
  { title: "The Boy and the Heron", year: 2023, playCount: 2, completed: true },
  { title: "A Few Good Men", year: 1992, playCount: 1, completed: false },
  { title: "Inside Out", year: 2015, playCount: 2, completed: false },
  { title: "Challengers", year: 2024, playCount: 1, completed: true },
  { title: "The Da Vinci Code", year: 2006, playCount: 1, completed: true },
  { title: "Mad Max: Fury Road", year: 2015, playCount: 1, completed: true },
  { title: "Civil War", year: 2024, playCount: 1, completed: true },
  { title: "The Greatest Love Story Never Told", year: 2024, playCount: 1, completed: false },
  { title: "Kung Fu Panda 4", year: 2024, playCount: 1, completed: false },
  { title: "The Ministry of Ungentlemanly Warfare", year: 2024, playCount: 1, completed: false },
  { title: "The Coffee Table", year: 2024, playCount: 2, completed: true },
  { title: "Godzilla Minus One", year: 2023, playCount: 1, completed: false },
  { title: "Sting", year: 2024, playCount: 1, completed: false },
  { title: "Infested", year: 2023, playCount: 1, completed: false },
  { title: "Migration", year: 2023, playCount: 1, completed: false },
  { title: "Willy Wonka & the Chocolate Factory", year: 1971, playCount: 3, completed: true },
  { title: "Late Night with the Devil", year: 2024, playCount: 2, completed: true },
  { title: "Dune: Part One", year: 2021, playCount: 6, completed: true },
  { title: "The Beekeeper", year: 2024, playCount: 2, completed: true },
  { title: "Tickled", year: 2016, playCount: 1, completed: false },
  { title: "Monkey Man", year: 2024, playCount: 1, completed: true },
  { title: "A Land Imagined", year: 2018, playCount: 1, completed: false },
  { title: "Dawn of the Dead", year: 2004, playCount: 1, completed: true },
  { title: "Madame Web", year: 2024, playCount: 3, completed: true },
  { title: "Inglourious Basterds", year: 2009, playCount: 1, completed: false },
  { title: "Oppenheimer", year: 2023, playCount: 2, completed: false },
  { title: "Coherence", year: 2014, playCount: 1, completed: true },
  { title: "22 Jump Street", year: 2014, playCount: 1, completed: true },
  { title: "Triangle", year: 2009, playCount: 1, completed: true },
  { title: "Spaceman", year: 2024, playCount: 1, completed: true },
  { title: "Wonka", year: 2023, playCount: 2, completed: true },
  { title: "The Lobster", year: 2015, playCount: 1, completed: false },
  { title: "The Zone of Interest", year: 2023, playCount: 1, completed: true },
  { title: "Mean Girls", year: 2004, playCount: 1, completed: true },
  { title: "Mean Girls", year: 2024, playCount: 1, completed: true },
  { title: "It's Such a Beautiful Day", year: 2016, playCount: 1, completed: true },
  { title: "Lover, Stalker, Killer", year: 2024, playCount: 1, completed: true },
  { title: "The Marvels", year: 2023, playCount: 3, completed: true },
  { title: "Deadpool 2", year: 2018, playCount: 1, completed: true },
  { title: "Deadpool", year: 2016, playCount: 1, completed: true },
  { title: "Wish", year: 2023, playCount: 1, completed: true },
  { title: "The Iron Claw", year: 2023, playCount: 1, completed: false },
  { title: "Anatomy of a Fall", year: 2023, playCount: 1, completed: true },
  { title: "V/H/S/85", year: 2023, playCount: 1, completed: true },
  { title: "The Witch", year: 2015, playCount: 1, completed: true },
  { title: "Elemental", year: 2023, playCount: 1, completed: true },
  { title: "Evil Dead Rise", year: 2023, playCount: 2, completed: true },
  { title: "Alien", year: 1979, playCount: 1, completed: true },
  { title: "Scream 3", year: 2000, playCount: 1, completed: true },
  { title: "Django Unchained", year: 2012, playCount: 2, completed: false },
  { title: "Knives Out", year: 2019, playCount: 1, completed: true },
  { title: "Scream 2", year: 1997, playCount: 1, completed: false },
  { title: "Scream", year: 1996, playCount: 1, completed: true },
  { title: "Guardians of the Galaxy Vol. 3", year: 2023, playCount: 1, completed: false },
  { title: "Whiplash", year: 2014, playCount: 3, completed: true },
  { title: "Beau Is Afraid", year: 2023, playCount: 3, completed: false },
  { title: "Carrie", year: 1976, playCount: 1, completed: true },
  { title: "Scream VI", year: 2023, playCount: 1, completed: true },
];

type Recommendation = {
  title: string;
  year: number;
  reason: string;
};

type EnrichedRecommendation = Recommendation & {
  tmdbId?: number;
  tmdbUrl?: string;
  posterUrl?: string;
};

const OUTPUT_TOOL = {
  name: 'output_recommendations',
  description: 'Provide the final list of movie recommendations.',
  inputSchema: {
    json: {
      type: 'object',
      properties: {
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Movie title' },
              year: { type: 'number', description: 'Release year' },
              reason: {
                type: 'string',
                description:
                  'One sentence explaining why this user would like it, referencing watched titles when possible.',
              },
            },
            required: ['title', 'year', 'reason'],
          },
        },
      },
      required: ['recommendations'],
    },
  },
} as const;

const buildPrompt = (
  watched: WatchedMovie[],
  exclude: string[] = [],
): string => {
  const compact = watched.map((m) => ({
    title: m.title,
    year: m.year,
    playCount: m.playCount,
    completed: m.completed,
  }));

  const watchedTitles = watched.map((m) => `${m.title} (${m.year})`);

  const lines = [
    'You recommend movies for a user. Use their watch history as a taste signal:',
    'playCount indicates favorites/rewatches; completed=false suggests they bailed.',
    '',
    'CRITICAL RULES:',
    '1. NEVER recommend any movie that appears in the EXCLUSION LIST below. The',
    '   user has already seen those.',
    `2. Recommend exactly ${NUM_RECOMMENDATIONS} DISTINCT movies that are NOT in the exclusion list.`,
    '3. No duplicates — each recommendation must be a different film.',
    '4. Vary genres and eras. Reasons should reference specific watched titles',
    '   when possible.',
    '',
    'EXCLUSION LIST — these are already watched, do NOT recommend any of them:',
    watchedTitles.join('; '),
  ];

  if (exclude.length) {
    lines.push(
      '',
      'ALSO do NOT recommend (already considered in a prior attempt):',
      exclude.join('; '),
    );
  }

  lines.push(
    '',
    'Taste signals (rich data for inferring preferences):',
    JSON.stringify(compact),
  );
  return lines.join('\n');
};

const callBedrock = async (prompt: string): Promise<Recommendation[]> => {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 2048, temperature: 0.9, topP: 0.95 },
      toolConfig: {
        tools: [{ toolSpec: OUTPUT_TOOL }],
        toolChoice: { tool: { name: OUTPUT_TOOL.name } },
      },
    }),
  );
  return extractRecommendations(
    response.output?.message?.content as
      | Array<{ toolUse?: { input?: unknown }; text?: string }>
      | undefined,
  );
};

const applyFilter = (
  raw: Recommendation[],
  seen: Set<string>,
): Recommendation[] =>
  raw.filter((r) => {
    const key = normalizeKey(r.title, r.year);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

const getRecentRecommendedTitles = async (
  userId: string,
  recentRuns = 10,
): Promise<string[]> => {
  try {
    const res = await ddb.send(
      new QueryCommand({
        TableName: REQUESTS_TABLE_NAME,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ScanIndexForward: false,
        Limit: recentRuns,
      }),
    );
    const titles = new Set<string>();
    for (const item of res.Items ?? []) {
      const recs = (item as { recommendations?: Recommendation[] }).recommendations ?? [];
      for (const r of recs) titles.add(`${r.title} (${r.year})`);
    }
    return Array.from(titles);
  } catch (err) {
    console.warn('Could not load recent recommended titles:', err);
    return [];
  }
};

const extractRecommendations = (
  content: Array<{ toolUse?: { input?: unknown }; text?: string }> | undefined,
): Recommendation[] => {
  const toolUse = content?.find((c) => c.toolUse)?.toolUse;
  const input = toolUse?.input as { recommendations?: Recommendation[] } | undefined;
  if (input?.recommendations?.length) return input.recommendations;

  // Fallback: parse text content if the model returned text instead of using the tool.
  const text = content?.find((c) => c.text)?.text ?? '';
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error(`Model returned no recommendations: ${text.slice(0, 200)}`);
  }
  const cleaned = text.slice(start, end + 1).replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(cleaned) as Recommendation[];
};

const normalizeKey = (title: string, year: number): string =>
  `${title.toLowerCase().trim()}|${year}`;

const getUserTmdbKey = async (userId: string): Promise<string | undefined> => {
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: SETTINGS_TABLE_NAME,
        Key: { userId },
      }),
    );
    return (res.Item as { tmdbApiKey?: string } | undefined)?.tmdbApiKey;
  } catch (err) {
    console.warn('Could not load user TMDB key:', err);
    return undefined;
  }
};

const enrichWithTmdb = async (
  rec: Recommendation,
  apiKey: string | undefined,
): Promise<EnrichedRecommendation> => {
  if (!apiKey) return rec;
  try {
    const url = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(
      rec.title,
    )}&year=${rec.year}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return rec;
    const json = (await res.json()) as {
      results?: Array<{ id: number; poster_path: string | null }>;
    };
    const first = json.results?.[0];
    if (!first) return rec;
    return {
      ...rec,
      tmdbId: first.id,
      tmdbUrl: `https://www.themoviedb.org/movie/${first.id}`,
      posterUrl: first.poster_path
        ? `https://image.tmdb.org/t/p/w500${first.poster_path}`
        : undefined,
    };
  } catch (err) {
    console.error(`TMDB lookup failed for "${rec.title}" (${rec.year}):`, err);
    return rec;
  }
};

export const handler: APIGatewayProxyHandler = async (event) => {
  // API Gateway's Cognito authorizer puts validated JWT claims here.
  // For this demo we still look up the seeded 'kyle' record regardless of who
  // authenticated — in production the partition key would be claims.sub.
  const claims = (event.requestContext as unknown as {
    authorizer?: { claims?: Record<string, string> };
  }).authorizer?.claims;

  const userSub = claims?.sub;

  // Try the per-user record first, fall back to the legacy shared 'kyle' record
  // for backwards compatibility with users who haven't imported their own
  // history yet.
  let watchHistoryRecord = userSub
    ? await ddb.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { userId: userSub } }),
      )
    : { Item: undefined };

  if (!watchHistoryRecord.Item) {
    watchHistoryRecord = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { userId: LEGACY_SHARED_USER_ID } }),
    );
  }

  // Use the user's imported history if they have any; otherwise fall back to a
  // default taste profile so brand-new users (and the demo) get recommendations
  // immediately instead of an error.
  const importedHistory = (watchHistoryRecord.Item?.watchHistory ?? []) as WatchedMovie[];
  const usingDefaultHistory = importedHistory.length === 0;
  const watched = usingDefaultHistory ? DEFAULT_WATCH_HISTORY : importedHistory;
  const watchedKeys = new Set(watched.map((m) => normalizeKey(m.title, m.year)));

  const requestUserId = userSub ?? LEGACY_SHARED_USER_ID;
  const recentTitles = await getRecentRecommendedTitles(requestUserId, 10);

  const seen = new Set(watchedKeys);
  let attempts = 1;
  const raw = await callBedrock(buildPrompt(watched, recentTitles));
  let filtered = applyFilter(raw, seen);

  // If the first attempt produced nothing usable (everything was already
  // watched or de-duped), retry once with an explicit exclusion list so the
  // model can't repeat the same picks.
  if (filtered.length === 0 && raw.length > 0) {
    attempts = 2;
    const exclude = [...recentTitles, ...raw.map((r) => `${r.title} (${r.year})`)];
    const retryRaw = await callBedrock(buildPrompt(watched, exclude));
    filtered = applyFilter(retryRaw, seen);
  }

  const tmdbKey = requestUserId ? await getUserTmdbKey(requestUserId) : undefined;
  const enriched = await Promise.all(filtered.map((rec) => enrichWithTmdb(rec, tmdbKey)));

  const runAt = Math.floor(Date.now() / 1000);
  const requestId = `${runAt}-${randomUUID().slice(0, 8)}`;

  await ddb.send(
    new PutCommand({
      TableName: REQUESTS_TABLE_NAME,
      Item: {
        userId: requestUserId,
        requestId,
        jobName: 'Manual run',
        runAt,
        status: 'success',
        recommendations: enriched,
        modelId: MODEL_ID,
        basedOnMovieCount: watched.length,
      },
    }),
  );

  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
    body: JSON.stringify({
      recommendations: enriched,
      meta: {
        userId: requestUserId,
        authenticatedAs: claims?.email ?? null,
        cognitoSub: claims?.sub ?? null,
        basedOnMovieCount: watched.length,
        usingDefaultHistory,
        modelId: MODEL_ID,
        filteredOutCount: raw.length - filtered.length,
        attempts,
        requestId,
      },
    }),
  };
};
