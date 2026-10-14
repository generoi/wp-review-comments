<?php

namespace GeneroWP\ReviewComments;

/**
 * Tells people about new comments: a Google Chat space through an incoming
 * webhook (one Chat thread per review thread), and optionally an email to
 * everyone in a thread when someone replies.
 */
class Notifications implements Module
{
    public const OPTION = 'wp_review_comments_settings';

    public function register(): void
    {
        add_action(Store::ACTION_CREATED, [$this, 'notify'], 10, 2);
    }

    /**
     * @return array{chat_webhook:string,email_participants:bool}
     */
    public static function settings(): array
    {
        $settings = (array) get_option(self::OPTION, []);

        return [
            'chat_webhook' => (string) ($settings['chat_webhook'] ?? ''),
            'email_participants' => ! empty($settings['email_participants']),
        ];
    }

    public static function saveSettings(string $webhook, bool $email): void
    {
        $webhook = esc_url_raw(trim($webhook));
        if ($webhook !== '' && ! self::isChatWebhook($webhook)) {
            $webhook = '';
        }
        update_option(self::OPTION, ['chat_webhook' => $webhook, 'email_participants' => $email], false);
    }

    public static function isChatWebhook(string $url): bool
    {
        $parts = wp_parse_url($url);

        return ($parts['scheme'] ?? '') === 'https' && ($parts['host'] ?? '') === 'chat.googleapis.com';
    }

    public function notify(int $id, bool $isReply): void
    {
        $post = get_post($id);
        $root = $post && $isReply ? get_post($post->post_parent) : $post;
        if (! $post || ! $root) {
            return;
        }
        $thread = Store::formatThread($root, true);
        $comment = Store::formatComment($post, true);
        $settings = self::settings();

        if ($settings['chat_webhook'] !== '') {
            self::sendChat($settings['chat_webhook'], $thread, $comment, $isReply);
        }
        if ($settings['email_participants'] && $isReply) {
            self::emailParticipants($thread, $comment);
        }
    }

    /**
     * Reviewer text in a Chat message: Chat reads <…> as links and mentions
     * (<users/all> pings the whole space), so angle brackets and the link
     * separator are swapped for look-alikes.
     */
    public static function chatSafe(string $text): string
    {
        return strtr($text, ['<' => '‹', '>' => '›', '|' => '¦']);
    }

    /**
     * @param  array<string, mixed>  $thread
     * @param  array<string, mixed>  $comment
     */
    public static function chatMessage(array $thread, array $comment, bool $isReply): string
    {
        $where = $thread['page_title'] ?: $thread['url'];
        $device = $thread['device'] ? ' ('.$thread['device'].(! empty($thread['browser']) ? ', '.$thread['browser'] : '').')' : '';
        $verb = $isReply ? 'replied on' : 'commented on';

        return sprintf(
            "*%s* %s %s%s:\n%s\n<%s|Open on the site>",
            self::chatSafe(str_replace('*', '', $comment['author'])),
            $verb,
            self::chatSafe($where),
            self::chatSafe($device),
            self::chatSafe(wp_trim_words($comment['text'], 60, '…')),
            esc_url_raw($thread['link'])
        );
    }

    /**
     * @param  array<string, mixed>  $thread
     * @param  array<string, mixed>  $comment
     */
    private static function sendChat(string $webhook, array $thread, array $comment, bool $isReply): void
    {
        $url = add_query_arg('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD', $webhook);
        wp_remote_post($url, [
            'blocking' => false,
            'timeout' => 3,
            'headers' => ['Content-Type' => 'application/json; charset=UTF-8'],
            'body' => wp_json_encode([
                'text' => self::chatMessage($thread, $comment, $isReply),
                'thread' => ['threadKey' => 'wprc-'.$thread['id']],
            ]),
        ]);
    }

    /**
     * @param  array<string, mixed>  $thread
     * @param  array<string, mixed>  $comment
     */
    private static function emailParticipants(array $thread, array $comment): void
    {
        // Guest addresses are unverified: a guest's reply only reaches people
        // with an account, so a review link cannot be used to mail strangers.
        $byGuest = ($comment['author_type'] ?? '') === 'guest';
        $emails = [];
        foreach (array_merge([$thread], $thread['replies']) as $entry) {
            $email = strtolower((string) ($entry['author_email'] ?? ''));
            if ($email === '' || ! is_email($email) || ($byGuest && ($entry['author_type'] ?? '') === 'guest')) {
                continue;
            }
            $emails[$email] = true;
        }
        unset($emails[strtolower((string) ($comment['author_email'] ?? ''))]);
        if (! $emails) {
            return;
        }
        $subject = sprintf(__('New reply: %s', 'wp-review-comments'), $thread['page_title'] ?: $thread['url']);
        $body = sprintf(
            "%s:\n\n%s\n\n%s\n%s",
            $comment['author'],
            $comment['text'],
            __('Open the thread:', 'wp-review-comments'),
            $thread['link']
        );
        foreach (array_slice(array_keys($emails), 0, 20) as $email) {
            wp_mail($email, $subject, $body);
        }
    }
}
