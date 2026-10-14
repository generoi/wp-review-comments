<?php

namespace GeneroWP\ReviewComments;

use WP_Error;
use WP_Post;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

/**
 * REST API used by the frontend overlay.
 */
class Rest implements Module
{
    public const NAMESPACE = 'wprc/v1';

    public function register(): void
    {
        add_action('rest_api_init', [self::class, 'routes']);
        add_filter('rest_post_dispatch', [self::class, 'noCache'], 10, 3);
        add_filter('rest_pre_dispatch', [self::class, 'requireOverlayHeader'], 10, 3);
    }

    /** Header the overlay sends with every request. */
    public const HEADER = 'X-WPRC';

    /**
     * Guests authenticate with cookies only, so require a custom header on
     * their requests: browsers cannot send it cross-site without a CORS
     * preflight, which WordPress does not allow for it. Logged-in users are
     * covered by the REST nonce.
     */
    public static function requireOverlayHeader(mixed $result, mixed $server, WP_REST_Request $request): mixed
    {
        if ($result !== null || ! str_starts_with($request->get_route(), '/'.self::NAMESPACE) || is_user_logged_in()) {
            return $result;
        }
        if ($request->get_header(strtolower(str_replace('-', '_', self::HEADER))) !== '1') {
            return new WP_Error('wprc_missing_header', __('Requests must come from the review overlay.', 'wp-review-comments'), ['status' => 403]);
        }

        return $result;
    }

    /**
     * Answers depend on the session cookie, so no page or edge cache may keep
     * them (Kinsta caches REST GETs when the site sends public headers).
     */
    public static function noCache(mixed $response, mixed $server, WP_REST_Request $request): mixed
    {
        if (str_starts_with($request->get_route(), '/'.self::NAMESPACE) && $response instanceof WP_REST_Response) {
            $response->header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
            $response->header('Vary', 'Cookie');
        }

        return $response;
    }

    public static function routes(): void
    {
        register_rest_route(self::NAMESPACE, '/boot', [
            'methods' => WP_REST_Server::READABLE,
            'callback' => [self::class, 'boot'],
            'permission_callback' => '__return_true',
            'args' => ['url' => ['type' => 'string']],
        ]);

        register_rest_route(self::NAMESPACE, '/session', [
            [
                'methods' => WP_REST_Server::CREATABLE,
                'callback' => [self::class, 'startSession'],
                'permission_callback' => '__return_true',
                'args' => ['token' => ['type' => 'string', 'required' => true]],
            ],
            [
                'methods' => WP_REST_Server::DELETABLE,
                'callback' => function () {
                    Session::end();

                    return ['ok' => true];
                },
                'permission_callback' => '__return_true',
            ],
        ]);

        register_rest_route(self::NAMESPACE, '/me', [
            'methods' => WP_REST_Server::READABLE,
            'callback' => [self::class, 'me'],
            'permission_callback' => '__return_true',
        ]);

        register_rest_route(self::NAMESPACE, '/threads', [
            'methods' => WP_REST_Server::READABLE,
            'callback' => [self::class, 'listAllThreads'],
            'permission_callback' => [Session::class, 'canComment'],
        ]);

        register_rest_route(self::NAMESPACE, '/comments', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => [self::class, 'listComments'],
                'permission_callback' => [Session::class, 'canComment'],
                'args' => ['url' => ['type' => 'string', 'required' => true]],
            ],
            [
                'methods' => WP_REST_Server::CREATABLE,
                'callback' => [self::class, 'createComment'],
                'permission_callback' => [Session::class, 'canComment'],
            ],
        ]);

        register_rest_route(self::NAMESPACE, '/comments/(?P<id>\d+)', [
            [
                'methods' => WP_REST_Server::EDITABLE,
                'callback' => [self::class, 'editComment'],
                'permission_callback' => [self::class, 'canModifyComment'],
                'args' => ['text' => ['type' => 'string', 'required' => true]],
            ],
            [
                'methods' => WP_REST_Server::DELETABLE,
                'callback' => [self::class, 'deleteComment'],
                'permission_callback' => [self::class, 'canModifyComment'],
            ],
        ]);

        register_rest_route(self::NAMESPACE, '/comments/(?P<id>\d+)/screenshot', [
            'methods' => WP_REST_Server::CREATABLE,
            'callback' => [self::class, 'saveScreenshot'],
            'permission_callback' => [self::class, 'canModifyComment'],
            'args' => ['image' => ['type' => 'string', 'required' => true]],
        ]);

        register_rest_route(self::NAMESPACE, '/comments/(?P<id>\d+)/status', [
            'methods' => WP_REST_Server::CREATABLE,
            'callback' => [self::class, 'setStatus'],
            'permission_callback' => [Session::class, 'isEditor'],
            'args' => ['status' => ['type' => 'string', 'enum' => Store::STATUSES, 'required' => true]],
        ]);
    }

    /**
     * Everything the overlay needs to start, in one request: the uncached
     * script URL, who is looking, and this page's threads.
     */
    public static function boot(WP_REST_Request $request): array
    {
        $me = self::me();

        $url = is_string($request['url']) ? $request['url'] : '';

        return [
            'script' => Frontend::scriptUrl(),
            'me' => $me,
            // The server's key for this page, so the overlay compares URLs the same way.
            'page' => $url !== '' ? Store::normalizeUrl($url) : null,
            'threads' => $me['can_comment'] && $url !== '' ? self::listComments($request) : null,
        ];
    }

    public static function startSession(WP_REST_Request $request): array|WP_Error
    {
        if ($limited = self::rateLimit('session', 20)) {
            return $limited;
        }
        $round = Session::start((string) $request['token']);
        if (is_wp_error($round)) {
            return $round;
        }

        return ['ok' => true, 'round' => get_the_title($round)];
    }

    public static function me(): array
    {
        $user = wp_get_current_user();
        $round = Session::currentRound();

        return [
            'can_comment' => Session::canComment(),
            'is_editor' => Session::isEditor(),
            'name' => $user->exists() ? $user->display_name : null,
            'round' => $round ? get_the_title($round) : null,
            // Only ask guests for an email address when it is used for something.
            'asks_email' => Notifications::settings()['email_participants'],
        ];
    }

    /**
     * Every thread on the site, without replies: what the walkthrough steps
     * through.
     */
    public static function listAllThreads(): array
    {
        $threads = array_filter(Store::queryThreads(['limit' => 500]), fn (WP_Post $post) => ! get_post_meta($post->ID, '_wprc_deleted', true) || Store::replies($post->ID));

        return array_values(array_map(fn (WP_Post $post) => [
            'id' => $post->ID,
            'url' => (string) get_post_meta($post->ID, '_wprc_url', true) ?: '/',
            'page_title' => (string) get_post_meta($post->ID, '_wprc_page_title', true),
            'status' => (string) get_post_meta($post->ID, '_wprc_status', true) ?: 'open',
            'device' => Store::device((string) get_post_meta($post->ID, '_wprc_viewport', true)),
            'created' => get_post_time('c', true, $post),
            'author' => Store::formatComment($post)['author'],
            'text' => wp_trim_words($post->post_content, 16, '…'),
        ], $threads));
    }

    public static function listComments(WP_REST_Request $request): array
    {
        $editor = Session::isEditor();

        return array_map(
            fn ($post) => Store::formatThread($post, $editor),
            Store::queryThreads(['url' => (string) $request['url']])
        );
    }

    public static function createComment(WP_REST_Request $request): array|WP_Error
    {
        if ($limited = self::rateLimit('comment', 60)) {
            return $limited;
        }
        // Only scalar values; arrays and objects are not valid for any field.
        $data = array_filter((array) $request->get_json_params(), 'is_scalar');
        $user = wp_get_current_user();
        if ($user->exists()) {
            $data['author_name'] = $user->display_name;
            $data['author_email'] = $user->user_email;
            $data['author_type'] = 'user';
            unset($data['guest_key']);
        } else {
            $data['author_name'] = trim((string) ($data['author_name'] ?? ''));
            if ($data['author_name'] === '') {
                return new WP_Error('wprc_name_required', __('Please enter your name.', 'wp-review-comments'), ['status' => 400]);
            }
            $data['author_type'] = 'guest';
            $data['guest_key'] = Session::ensureGuestKey();
        }
        $data['round'] = Session::currentRound() ?? 0;
        if ($data['round'] && ! Session::isEditor() && ($limited = self::rateLimit('round_'.$data['round'], 300, false))) {
            return $limited;
        }
        $data['user_agent'] = $request->get_header('user_agent');
        unset($data['status']);

        $id = Store::createComment($data);
        if (is_wp_error($id)) {
            return $id;
        }

        return self::threadOf($id);
    }

    public static function canModifyComment(WP_REST_Request $request): bool
    {
        $post = get_post((int) $request['id']);

        return $post && $post->post_type === Store::COMMENT && Session::canComment() && Store::canModify($post);
    }

    /** Thread of a comment, or null when the thread itself is gone. */
    private static function rootOf(int $id): ?WP_Post
    {
        $post = get_post($id);
        if (! $post || $post->post_type !== Store::COMMENT) {
            return null;
        }
        $root = $post->post_parent ? get_post($post->post_parent) : $post;

        return $root && $root->post_type === Store::COMMENT ? $root : null;
    }

    public static function editComment(WP_REST_Request $request): array|WP_Error
    {
        $id = (int) $request['id'];
        $result = Store::updateText($id, (string) $request['text']);

        return is_wp_error($result) ? $result : self::threadOf($id);
    }

    public static function deleteComment(WP_REST_Request $request): array|WP_Error
    {
        $id = (int) $request['id'];
        $root = self::rootOf($id);
        $rootId = $root ? $root->ID : $id;
        $result = Store::deleteComment($id);
        if (is_wp_error($result)) {
            return $result;
        }
        $root = get_post($rootId);
        $visible = $root && $root->post_status === 'publish';

        return ['deleted' => $id, 'thread' => $visible ? Store::formatThread($root, Session::isEditor()) : null, 'removed' => $visible ? null : $rootId];
    }

    public static function saveScreenshot(WP_REST_Request $request): array|WP_Error
    {
        $id = (int) $request['id'];
        if ($limited = self::rateLimit('screenshot', 60)) {
            return $limited;
        }
        if (get_post($id)->post_parent) {
            return new WP_Error('wprc_not_thread', __('Screenshots belong to threads.', 'wp-review-comments'), ['status' => 400]);
        }
        $url = Store::saveScreenshot($id, (string) $request['image']);

        return is_wp_error($url) ? $url : ['screenshot' => $url];
    }

    public static function setStatus(WP_REST_Request $request): array|WP_Error
    {
        $result = Store::setStatus((int) $request['id'], (string) $request['status']);
        if (is_wp_error($result)) {
            return $result;
        }

        return self::threadOf((int) $request['id']);
    }

    private static function threadOf(int $id): array|WP_Error
    {
        $root = self::rootOf($id);
        if (! $root) {
            return new WP_Error('wprc_not_found', __('Thread not found.', 'wp-review-comments'), ['status' => 404]);
        }

        return Store::formatThread($root, Session::isEditor());
    }

    /**
     * Simple per-IP limit: $max requests per action every 10 minutes.
     */
    private static function rateLimit(string $action, int $max, bool $perIp = true): ?WP_Error
    {
        if (Session::isEditor()) {
            return null;
        }
        /**
         * Client IP used for rate limits. Behind a proxy that does not rewrite
         * REMOTE_ADDR, return the forwarded address here.
         */
        $ip = (string) apply_filters('wp_review_comments_client_ip', $_SERVER['REMOTE_ADDR'] ?? '');
        $key = 'wprc_rl_'.$action.($perIp ? '_'.md5($ip) : '');
        $count = (int) get_transient($key);
        if ($count >= $max) {
            return new WP_Error('wprc_rate_limited', __('Too many requests, try again in a few minutes.', 'wp-review-comments'), ['status' => 429]);
        }
        set_transient($key, $count + 1, 10 * MINUTE_IN_SECONDS);

        return null;
    }
}
