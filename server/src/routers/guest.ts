import { Router } from 'express';
import db from '../db';
import { asyncHandler } from '../express-helpers';
import { roles } from '../guards';
import { aggregateReviewScore, groupBy, modeBy } from '../helpers';
import { accessSetting } from '../settings';
import { isGameMode } from '../type-guards';

const guestRouter = Router();
export default guestRouter;

guestRouter.get('/', (_, res) => {
  res.send('This is the API for <a href="https://loved.sh">loved.sh</a>. You shouldn\'t be here!');
});

// TODO: is not needed publicly anymore. check usage
guestRouter.get(
  '/captains',
  asyncHandler(async (_, res) => {
    res.json(
      groupBy<GameMode, UserWithRoles>(
        await db.queryWithGroups<UserWithRoles>(`
          SELECT users.*, user_roles:roles
          FROM users
          INNER JOIN user_roles
            ON users.id = user_roles.user_id
          WHERE user_roles.captain_game_mode IS NOT NULL
          ORDER BY users.name ASC
        `),
        'roles.captain_game_mode',
      ),
    );
  }),
);

guestRouter.get(
  '/mapper-consents',
  asyncHandler(async (_, res) => {
    const beatmapsetConsentsByMapperId = groupBy<
      ConsentBeatmapset['user_id'],
      ConsentBeatmapset & { beatmapset: Beatmapset }
    >(
      await db.queryWithGroups<ConsentBeatmapset & { beatmapset: Beatmapset }>(`
        SELECT mapper_consent_beatmapsets.*, beatmapsets:beatmapset
        FROM mapper_consent_beatmapsets
        INNER JOIN beatmapsets
          ON mapper_consent_beatmapsets.beatmapset_id = beatmapsets.id
      `),
      'user_id',
    );
    const consents: (Consent & {
      beatmapset_consents?: (ConsentBeatmapset & { beatmapset: Beatmapset })[];
      mapper: User;
    })[] = await db.queryWithGroups<Consent & { mapper: User }>(`
      SELECT mapper_consents.*, mappers:mapper
      FROM mapper_consents
      INNER JOIN users AS mappers
        ON mapper_consents.user_id = mappers.id
      ORDER BY \`mapper:name\` ASC
    `);

    consents.forEach((consent) => {
      consent.beatmapset_consents = beatmapsetConsentsByMapperId[consent.user_id] || [];
    });

    res.json(consents);
  }),
);

guestRouter.get(
  '/stats/polls',
  asyncHandler(async (_, res) => {
    res.json(
      await db.queryWithGroups<
        Poll & {
          beatmapset: Beatmapset | null;
          voting_threshold: RoundGameMode['voting_threshold'] | null;
        }
      >(`
        SELECT polls.*, beatmapsets:beatmapset, round_game_modes.voting_threshold
        FROM polls
        LEFT JOIN beatmapsets
          ON polls.beatmapset_id = beatmapsets.id
        LEFT JOIN round_game_modes
          ON polls.round_id = round_game_modes.round_id
            AND polls.game_mode = round_game_modes.game_mode
        ORDER BY polls.ended_at DESC
      `),
    );
  }),
);

guestRouter.get(
  '/submissions',
  asyncHandler(async (req, res) => {
    const gameMode = parseInt(req.query.gameMode ?? '', 10);

    if (!isGameMode(gameMode)) {
      return res.status(422).json({ error: 'Invalid game mode' });
    }

    const beatmapsetIds = new Set<number>();
    const userIds = new Set<number>();
    const canViewNominationStatus =
      !accessSetting(`hideNominationStatus.${gameMode}`) || roles(req, res).gameModes[gameMode];

    const submissions = await db.query<Submission>(
      `
        SELECT *
        FROM submissions
        WHERE game_mode = ?
        ORDER BY submitted_at ASC
      `,
      [gameMode],
    );

    for (const submission of submissions) {
      beatmapsetIds.add(submission.beatmapset_id);

      if (submission.submitter_id != null) {
        userIds.add(submission.submitter_id);
      }
    }

    const reviews = await db.query<Review>(
      `
        SELECT *
        FROM reviews
        WHERE game_mode = ?
        ORDER BY reviewed_at ASC
      `,
      [gameMode],
    );

    for (const review of reviews) {
      beatmapsetIds.add(review.beatmapset_id);
      userIds.add(review.reviewer_id);
    }

    if (beatmapsetIds.size === 0) {
      return res.json({
        beatmapsets: [],
        usersById: {},
      });
    }

    const beatmapsets: (Beatmapset &
      Partial<{
        beatmap_counts: Record<GameMode, number>;
        consent: boolean | null;
        key_modes: number[];
        maximum_length: number;
        modal_bpm: number;
        nominated_round_name: string | null;
        poll: Partial<Pick<Poll, 'beatmapset_id'>> &
          Pick<Poll, 'topic_id'> & { in_progress: 0 | 1 | boolean; passed: 0 | 1 | boolean };
        review_score: number;
        reviews: Review[];
        score: number;
        strictly_rejected: boolean;
        submissions: Submission[];
      }>)[] = await db.query<Beatmapset>(
      `
        SELECT *
        FROM beatmapsets
        WHERE id IN (?)
      `,
      [[...beatmapsetIds]],
    );
    const beatmapsByBeatmapsetId = groupBy<
      Beatmap['beatmapset_id'],
      Pick<
        Beatmap,
        'beatmapset_id' | 'bpm' | 'game_mode' | 'key_count' | 'play_count' | 'total_length'
      >
    >(
      await db.query<
        Pick<
          Beatmap,
          'beatmapset_id' | 'bpm' | 'game_mode' | 'key_count' | 'play_count' | 'total_length'
        >
      >(
        `
          SELECT beatmapset_id, bpm, game_mode, key_count, play_count, total_length
          FROM beatmaps
          WHERE beatmapset_id IN (?)
        `,
        [[...beatmapsetIds]],
      ),
      'beatmapset_id',
    );
    const futureNominationsByBeatmapsetId =
      canViewNominationStatus &&
      groupBy<Nomination['beatmapset_id'], Round['name']>(
        await db.query<Pick<Nomination, 'beatmapset_id'> & Pick<Round, 'name'>>(
          `
            SELECT nominations.beatmapset_id, rounds.name
            FROM nominations
            INNER JOIN rounds
              ON nominations.round_id = rounds.id
            WHERE nominations.beatmapset_id IN (?)
              AND nominations.game_mode = ?
              AND rounds.done = 0
            ORDER BY rounds.id DESC
          `,
          [[...beatmapsetIds], gameMode],
        ),
        'beatmapset_id',
        'name',
      );
    // TODO: Scope to complete polls when incomplete polls are stored in `polls`
    const pollByBeatmapsetId = groupBy<
      Poll['beatmapset_id'],
      Pick<Poll, 'beatmapset_id' | 'topic_id'> & { in_progress: 0 | 1; passed: 0 | 1 }
    >(
      await db.query<
        Pick<Poll, 'beatmapset_id' | 'topic_id'> & { in_progress: 0 | 1; passed: 0 | 1 }
      >(
        `
          SELECT polls.beatmapset_id, polls.topic_id,
            polls.result_no IS NULL OR polls.result_yes IS NULL AS in_progress,
            polls.result_no IS NOT NULL AND polls.result_yes IS NOT NULL AND
              polls.result_yes / (polls.result_no + polls.result_yes) >= round_game_modes.voting_threshold AS passed
          FROM polls
          INNER JOIN round_game_modes
            ON polls.round_id = round_game_modes.round_id
              AND polls.game_mode = round_game_modes.game_mode
          WHERE polls.id IN (
            SELECT MAX(id)
            FROM polls
            WHERE game_mode = ?
            GROUP BY beatmapset_id
          )
            AND polls.beatmapset_id IN (?)
        `,
        [gameMode, [...beatmapsetIds]],
      ),
      'beatmapset_id',
      null,
      true,
    );
    const reviewsByBeatmapsetId = groupBy<Review['beatmapset_id'], Review>(
      reviews,
      'beatmapset_id',
    );
    const submissionsByBeatmapsetId = groupBy<Submission['beatmapset_id'], Submission>(
      submissions,
      'beatmapset_id',
    );

    const beatmapsetConsentByBeatmapsetUserKey = groupBy<
      `${number}-${number}`,
      ConsentBeatmapset['consent'] | undefined
    >(
      await db.query<
        Pick<ConsentBeatmapset, 'consent'> & { beatmapset_user: `${number}-${number}` }
      >(
        `
          SELECT consent, CONCAT(beatmapset_id, '-', user_id) as beatmapset_user
          FROM mapper_consent_beatmapsets
          WHERE beatmapset_id IN (?)
        `,
        [[...beatmapsetIds]],
      ),
      'beatmapset_user',
      'consent',
      true,
    );
    const consentByUserId = groupBy<Consent['user_id'], Consent['consent']>(
      await db.query<Pick<Consent, 'consent' | 'user_id'>>(
        `
          SELECT consent, user_id
          FROM mapper_consents
          WHERE user_id IN (
            SELECT creator_id
            FROM beatmapsets
            WHERE id IN (?)
          )
        `,
        [[...beatmapsetIds]],
      ),
      'user_id',
      'consent',
      true,
    );

    for (const beatmapset of beatmapsets) {
      const beatmaps = groupBy<
        Beatmap['game_mode'],
        Pick<
          Beatmap,
          'beatmapset_id' | 'bpm' | 'game_mode' | 'key_count' | 'play_count' | 'total_length'
        >
      >(beatmapsByBeatmapsetId[beatmapset.id] || [], 'game_mode');
      const beatmapsForGameMode = beatmaps[gameMode]?.sort((a, b) => a.bpm - b.bpm) || [];
      const consent: ConsentValue | boolean | null =
        beatmapsetConsentByBeatmapsetUserKey[`${beatmapset.id}-${beatmapset.creator_id}`] ??
        consentByUserId[beatmapset.creator_id];

      beatmapset.reviews = reviewsByBeatmapsetId[beatmapset.id] || [];
      beatmapset.submissions = submissionsByBeatmapsetId[beatmapset.id] || [];

      beatmapset.consent =
        consent == null || consent === ConsentValue.unreachable ? null : !!consent;
      beatmapset.key_modes = (
        [...new Set(beatmapsForGameMode.map((b) => b.key_count))].filter(
          (k) => k != null,
        ) as number[]
      ).sort((a, b) => a - b);
      beatmapset.maximum_length = Math.max(
        ...beatmapsForGameMode.map((beatmap) => beatmap.total_length),
      );
      beatmapset.modal_bpm = modeBy(beatmapsForGameMode, 'bpm');
      beatmapset.nominated_round_name = canViewNominationStatus
        ? (futureNominationsByBeatmapsetId as Record<number, string[] | undefined>)[
            beatmapset.id
          ]?.[0] ?? null
        : null;
      beatmapset.play_count = beatmapsForGameMode.reduce(
        (sum, beatmap) => sum + beatmap.play_count,
        0,
      );
      beatmapset.poll = pollByBeatmapsetId[beatmapset.id];
      beatmapset.review_score = aggregateReviewScore(beatmapset.reviews);
      beatmapset.score = beatmapset.favorite_count * 75 + beatmapset.play_count;
      beatmapset.strictly_rejected = beatmapset.reviews.some((review) => review.score < -3);

      if (beatmapset.poll != null) {
        delete beatmapset.poll.beatmapset_id;
        beatmapset.poll.in_progress = beatmapset.poll.in_progress > 0;
        beatmapset.poll.passed = beatmapset.poll.passed > 0;
      }

      beatmapset.beatmap_counts = {};
      for (const gameMode of [0, 1, 2, 3]) {
        beatmapset.beatmap_counts[gameMode] = beatmaps[gameMode]?.length ?? 0;
      }

      userIds.add(beatmapset.creator_id);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    beatmapsets.sort((a, b) => b.score! - a.score!);

    // Should never happen
    if (userIds.size === 0) {
      return res.json({
        beatmapsets: [],
        usersById: {},
      });
    }

    const usersById = groupBy<User['id'], User & { alumni: UserRoles['alumni'] | null }>(
      await db.query<User & { alumni: UserRoles['alumni'] | null }>(
        `
          SELECT users.*, user_roles.alumni
          FROM users
          LEFT JOIN user_roles
            ON users.id = user_roles.user_id
          WHERE users.id IN (?)
        `,
        [[...userIds]],
      ),
      'id',
      null,
      true,
    );

    res.json({
      beatmapsets,
      usersById,
    });
  }),
);

guestRouter.get(
  '/team',
  asyncHandler(async (_, res) => {
    const team = (
      await db.queryWithGroups<UserWithRoles>(`
        SELECT users.*, user_roles:roles
        FROM users
        INNER JOIN user_roles
          ON users.id = user_roles.user_id
        ORDER BY users.name ASC
      `)
    ).filter((user) =>
      Object.entries(user.roles).some(([role, value]) => !role.startsWith('god') && value === true),
    );

    const alumni = groupBy<UserRoles['alumni_game_mode'], UserWithRoles, 'other'>(
      team.filter((user) => user.roles.alumni),
      'roles.alumni_game_mode',
      null,
      false,
      'other',
    );

    const allCurrent = team.filter((user) => !user.roles.alumni);
    const current = groupBy<UserRoles['captain_game_mode'], UserWithRoles>(
      allCurrent,
      'roles.captain_game_mode',
    ) as Record<Exclude<UserRoles['captain_game_mode'], null>, UserWithRoles[]> &
      Partial<Record<'dev' | 'metadata' | 'moderator' | 'news', UserWithRoles[]>> &
      Partial<{ null: UserWithRoles[] }>;
    delete current.null;

    for (const role of ['dev', 'metadata', 'moderator', 'news'] as const) {
      const usersWithRole = allCurrent.filter((user) => user.roles[role]);

      if (usersWithRole.length > 0) {
        current[role] = usersWithRole;
      }
    }

    res.json({ alumni, current });
  }),
);
