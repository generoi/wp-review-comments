<?php

namespace GeneroWP\ReviewComments;

use WP_Error;

/**
 * Guest access through review rounds.
 *
 * An admin creates a round and shares its link (`?review=<token>`). Only a
 * hash of the token is stored. Opening the link exchanges the token for a
 * signed, HttpOnly session cookie bound to the round, so revoking or expiring
 * the round ends every guest session made from it.
 */
class Session
{
    public const COOKIE = 'wprc_session';

    /** Readable by JS; only tells the loader to start the overlay. */
    public const FLAG_COOKIE = 'wprc_on';

    public static function createRound(string $name, int $days): array|WP_Error
    {
        $token = wp_generate_password(32, false, false);
        $id = wp_insert_post([
            'post_type' => Store::ROUND,
            'post_status' => 'publish',
            'post_title' => sanitize_text_field($name) ?: __('Review', 'wp-review-comments'),
        ], true);
        if (is_wp_error($id)) {
            return $id;
        }
        update_post_meta($id, '_wprc_token_hash', self::hashToken($token));
        update_post_meta($id, '_wprc_expires', time() + max(1, $days) * DAY_IN_SECONDS);

        return ['id' => $id, 'token' => $token, 'link' => add_query_arg('review', $token, home_url('/'))];
    }

    public static function revokeRound(int $id): void
    {
        update_post_meta($id, '_wprc_revoked', 1);
    }

    public static function isRoundActive(int $id): bool
    {
        $round = get_post($id);

        return $round
            && $round->post_type === Store::ROUND
            && ! get_post_meta($id, '_wprc_revoked', true)
            && (int) get_post_meta($id, '_wprc_expires', true) > time();
    }

    public static function findRoundByToken(string $token): ?int
    {
        if (strlen($token) < 16) {
            return null;
        }
        $ids = get_posts([
            'post_type' => Store::ROUND,
            'post_status' => 'publish',
            'fields' => 'ids',
            'posts_per_page' => 1,
            'meta_key' => '_wprc_token_hash',
            'meta_value' => self::hashToken($token),
        ]);

        return $ids ? (int) $ids[0] : null;
    }

    /**
     * Exchange a link token for a session cookie.
     */
    public static function start(string $token): int|WP_Error
    {
        $round = self::findRoundByToken($token);
        if (! $round || ! self::isRoundActive($round)) {
            return new WP_Error('wprc_invalid_link', __('This review link is invalid or has expired.', 'wp-review-comments'), ['status' => 403]);
        }
        $expires = (int) get_post_meta($round, '_wprc_expires', true);
        $value = $round.'.'.$expires.'.'.self::sign($round, $expires);
        self::setCookie(self::COOKIE, $value, $expires, true);
        self::setCookie(self::FLAG_COOKIE, '1', $expires, false);

        return $round;
    }

    public static function end(): void
    {
        self::setCookie(self::COOKIE, '', time() - HOUR_IN_SECONDS, true);
        self::setCookie(self::FLAG_COOKIE, '', time() - HOUR_IN_SECONDS, false);
    }

    /**
     * Round of the current guest session, or null.
     */
    public static function currentRound(): ?int
    {
        $value = $_COOKIE[self::COOKIE] ?? '';
        if (! is_string($value) || substr_count($value, '.') !== 2) {
            return null;
        }
        [$round, $expires, $signature] = explode('.', $value);
        $round = (int) $round;
        $expires = (int) $expires;
        if (! hash_equals(self::sign($round, $expires), $signature) || $expires < time()) {
            return null;
        }

        return self::isRoundActive($round) ? $round : null;
    }

    public static function isEditor(): bool
    {
        return current_user_can('edit_posts');
    }

    public static function canComment(): bool
    {
        return self::isEditor() || self::currentRound() !== null;
    }

    private static function hashToken(string $token): string
    {
        return hash_hmac('sha256', $token, wp_salt('auth'));
    }

    private static function sign(int $round, int $expires): string
    {
        $tokenHash = (string) get_post_meta($round, '_wprc_token_hash', true);

        return hash_hmac('sha256', $round.'|'.$expires.'|'.$tokenHash, wp_salt('secure_auth'));
    }

    private static function setCookie(string $name, string $value, int $expires, bool $httpOnly): void
    {
        setcookie($name, $value, [
            'expires' => $expires,
            'path' => COOKIEPATH ?: '/',
            'domain' => COOKIE_DOMAIN ?: '',
            'secure' => is_ssl(),
            'httponly' => $httpOnly,
            'samesite' => 'Lax',
        ]);
    }
}
