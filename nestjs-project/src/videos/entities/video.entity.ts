import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoStatus } from '../video-status.enum';

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16, unique: true })
  public_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Index()
  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 512 })
  source_key: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 127 })
  content_type: string;

  // bigint maps to string in the pg driver — a 10GB size exceeds what the
  // driver is willing to hand back as a JS number without an explicit cast.
  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 3, nullable: true })
  duration_seconds: string | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  container_format: string | null;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
